/** Model-based enrichment: prompt + defensive parsing, merged with local evidence. */

import type { Enrichment, KeyMoment } from './enrich';
import { neutralise, SYSTEM_RULES } from './agent/guard';
import { countTerm } from './highlights';

export interface TimedLine {
  startMs: number | null;
  text: string;
}

export interface EnrichmentSource {
  title: string;
  url: string | null;
  note: string;
  /** Full text (transcripts, description, article). Used when there are no timed segments. */
  body: string;
  /** Transcript segments; when any has a start time the model sees `[mm:ss]` markers. */
  timed?: TimedLine[];
  description?: string;
}

const TEXT_BUDGET = 14000;
/** A model timestamp counts only if it lands this close to a real segment start. */
const START_TOLERANCE_MS = 2000;

/** `[mm:ss]` (or `[h:mm:ss]`) marker for a segment start. */
export function marker(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `[${h}:${mm}:${ss}]` : `[${mm}:${ss}]`;
}

/** Parse "mm:ss", "h:mm:ss" or "[mm:ss]" into milliseconds. */
export function parseMarker(s: string): number | null {
  const m = /^\[?\s*(?:(\d+):)?(\d{1,3}):(\d{2})\s*\]?$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

/**
 * Transcript lines with `[mm:ss]` markers. Short segments are merged into
 * longer windows until the text fits the budget (then each window is
 * shortened); every marker is still the start of a real segment, so the
 * model can only point at real moments.
 */
export function timedTranscript(timed: TimedLine[], budget = TEXT_BUDGET): string {
  const segs = timed.filter((s): s is { startMs: number; text: string } => s.startMs !== null && !!s.text.trim());
  if (!segs.length) return '';
  let lines: string[] = [];
  for (const windowMs of [0, 15_000, 30_000, 60_000, 120_000, 300_000]) {
    lines = [];
    let start = segs[0].startMs;
    let buf: string[] = [];
    for (const s of segs) {
      if (buf.length && s.startMs - start >= windowMs) {
        lines.push(`${marker(start)} ${buf.join(' ')}`);
        buf = [];
        start = s.startMs;
      }
      if (!buf.length) start = s.startMs;
      buf.push(s.text.replace(/\s+/g, ' ').trim());
    }
    if (buf.length) lines.push(`${marker(start)} ${buf.join(' ')}`);
    if (lines.join('\n').length <= budget) return lines.join('\n');
  }
  // Still too long: shorten every window evenly so the whole video stays covered.
  const per = Math.max(20, Math.floor(budget / lines.length) - 1);
  return lines.map((l) => (l.length > per ? `${l.slice(0, per - 1)}…` : l)).join('\n').slice(0, budget);
}

export function enrichmentPrompt(src: EnrichmentSource): string {
  const transcript = timedTranscript(src.timed ?? []);
  const text = transcript
    ? `Transcript (each line starts with its [mm:ss] time):\n${neutralise(transcript, TEXT_BUDGET)}${src.description ? `\nDescription: ${neutralise(src.description, 2000)}` : ''}`
    : `Text: ${neutralise(src.body, TEXT_BUDGET)}`;
  return `${SYSTEM_RULES}

Extract structured knowledge from the single SOURCE below. Respond with ONLY a JSON object with these keys:
"tldr" (one sentence, at most 30 words),
"keyPoints" (3-7 objects {"text": string, "startMs": integer}${transcript ? '; startMs is the [mm:ss] marker of the line where the point is made, in milliseconds ([01:05] → 65000); omit startMs if unsure' : '; omit startMs, this source has no timestamps'}),
"concepts" (2-4-word phrases copied verbatim from the source, at most 8),
"tags" (string[] of short lowercase tags),
"actionItems" (string[], only steps the source tells the viewer to do).
Use only information present in the source. Never invent timestamps.

<source id="S1">
Title: ${neutralise(src.title, 300)}
URL: ${neutralise(src.url ?? '', 300)}
User note: ${neutralise(src.note, 2000)}
${text}
</source>

JSON:`;
}

/** Evidence the model output is checked against. */
export interface EnrichmentEvidence {
  /** Everything the model was shown (title, note, transcript, description). */
  text: string;
  /** Real segment start times. */
  segmentStarts: number[];
}

/** Snap a model time to the real segment start within ±2 s, or drop it. */
export function validStart(value: unknown, starts: number[]): number | null {
  if (!starts.length) return null;
  const candidates: number[] = [];
  // Some models answer in seconds; a small number is read as seconds first.
  const numeric = (n: number) => (n < 10_000 ? [n * 1000, n] : [n]);
  if (typeof value === 'number' && Number.isFinite(value)) candidates.push(...numeric(value));
  else if (typeof value === 'string') {
    const ms = parseMarker(value);
    if (ms !== null) candidates.push(ms);
    else if (/^\d+$/.test(value.trim())) candidates.push(...numeric(Number(value)));
  }
  for (const v of candidates) {
    let best: number | null = null;
    for (const s of starts) if (Math.abs(s - v) <= START_TOLERANCE_MS && (best === null || Math.abs(s - v) < Math.abs(best - v))) best = s;
    if (best !== null) return best;
  }
  return null;
}

/** A concept must occur in the source, whitespace and case aside. */
function occursIn(text: string, phrase: string): boolean {
  const p = phrase.replace(/\s+/g, ' ').trim();
  return !!p && countTerm(text.replace(/\s+/g, ' '), p) > 0;
}

export function parseModelEnrichment(raw: string, evidence?: EnrichmentEvidence): Partial<Enrichment> | null {
  const m = /\{[\s\S]*\}/.exec(raw ?? '');
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const list = (k: string, max = 20) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 300)).slice(0, max) : []);
  const str = (k: string, max: number) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, max) : '');
  // keyPoints may be objects ({text, startMs}) or, from older prompts, plain strings.
  const keyMoments: KeyMoment[] = (Array.isArray(o.keyPoints) ? (o.keyPoints as unknown[]) : [])
    .map((k): KeyMoment | null => {
      if (typeof k === 'string') return { text: k, startMs: null };
      if (!k || typeof k !== 'object') return null;
      const r = k as Record<string, unknown>;
      const text = typeof r.text === 'string' ? r.text : typeof r.point === 'string' ? r.point : '';
      const at = r.startMs ?? r.start ?? r.t ?? r.time ?? null;
      return { text, startMs: evidence ? validStart(at, evidence.segmentStarts) : null };
    })
    .filter((k): k is KeyMoment => !!k && !!k.text.trim())
    .map((k) => ({ ...k, text: k.text.trim().slice(0, 300) }))
    .slice(0, 10);
  const tldr = str('tldr', 400);
  const summary = str('summary', 2000) || tldr;
  if (!summary && !keyMoments.length) return null;
  let concepts = list('concepts', 15).map((s) => s.trim()).filter((s) => s && s.split(/\s+/).length <= 4);
  if (evidence) concepts = concepts.filter((cpt) => occursIn(evidence.text, cpt));
  return {
    summary,
    tldr: tldr || undefined,
    keyPoints: keyMoments.map((k) => k.text),
    keyMoments,
    concepts: [...new Map(concepts.map((cpt) => [cpt.toLowerCase(), cpt])).values()].slice(0, 8),
    tags: list('tags', 8).map((t) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 40)),
    followUpQuestions: list('followUpQuestions', 8),
    actionItems: list('actionItems', 8),
  };
}

/**
 * Model output never replaces evidence: commands, repositories, URLs and
 * timestamps stay as extracted verbatim from the source.
 */
export function mergeModelEnrichment(local: Enrichment, model: Partial<Enrichment>, provider: string, now: string): Enrichment {
  const useModelPoints = !!model.keyPoints?.length;
  return {
    ...local,
    origin: 'model',
    provider,
    generatedAt: now,
    summary: model.summary || local.summary,
    tldr: model.tldr || model.summary || local.tldr,
    keyPoints: useModelPoints ? (model.keyPoints as string[]) : local.keyPoints,
    keyMoments: useModelPoints ? model.keyMoments : local.keyMoments,
    concepts: model.concepts?.length ? model.concepts : local.concepts,
    tags: model.tags?.length ? model.tags : local.tags,
    followUpQuestions: model.followUpQuestions ?? [],
    actionItems: model.actionItems?.length ? model.actionItems : local.actionItems,
  };
}
