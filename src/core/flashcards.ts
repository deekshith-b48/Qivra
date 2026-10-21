/**
 * Flashcards from a saved item: a model prompt with defensive parsing, a local
 * cloze fallback, and SM-2-lite scheduling.
 *
 * Model output is never trusted: an answer must occur verbatim in what the
 * model was shown, and a time must snap to a real key-moment start.
 */

import { neutralise, SYSTEM_RULES } from './agent/guard';
import { keyMomentsOf, type Enrichment, type KeyMoment } from './enrich';
import { marker, validStart } from './enrichModel';

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface CardDraft {
  front: string;
  back: string;
  startMs: number | null;
}

export interface CardSchedule {
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
}

export interface FlashcardSource {
  title: string;
  tldr: string;
  keyMoments: KeyMoment[];
  concepts: string[];
}

export const MAX_CARDS = 8;
const MAX_FRONT = 200;
const MAX_BACK = 160;
const MAX_ANSWER_WORDS = 15;

export function flashcardSource(title: string, e: Enrichment | null | undefined): FlashcardSource {
  return {
    title,
    tldr: (e?.tldr || e?.summary || '').trim(),
    keyMoments: keyMomentsOf(e).filter((k) => k.text?.trim()).slice(0, 12),
    concepts: (e?.concepts ?? []).filter(Boolean).slice(0, 12),
  };
}

/** Everything the model is shown; answers are checked against it. */
export function sourceEvidence(src: FlashcardSource): { text: string; starts: number[] } {
  return {
    text: [src.title, src.tldr, ...src.keyMoments.map((k) => k.text), ...src.concepts].join('\n'),
    starts: src.keyMoments.flatMap((k) => (k.startMs === null || k.startMs === undefined ? [] : [k.startMs])),
  };
}

export function flashcardPrompt(src: FlashcardSource): string {
  const moments = src.keyMoments
    .map((k) => `- ${k.startMs !== null && k.startMs !== undefined ? `${marker(k.startMs)} ` : ''}${neutralise(k.text, 400)}`)
    .join('\n');
  const timed = src.keyMoments.some((k) => k.startMs !== null && k.startMs !== undefined);
  return `${SYSTEM_RULES}

Write 3-8 study flashcards from the single SOURCE below. Respond with ONLY a JSON object:
{"cards": [{"q": string, "a": string${timed ? ', "startMs": integer' : ''}}]}
- "q" is a short question answerable from the source.
- "a" is the answer: a phrase of at most ${MAX_ANSWER_WORDS} words copied verbatim from the source.
${timed ? '- "startMs" is the [mm:ss] marker of the key moment the answer comes from, in milliseconds ([01:05] → 65000); omit it if unsure.\n' : ''}Use only information present in the source. Never invent answers or timestamps.

<source id="S1">
Title: ${neutralise(src.title, 300)}
TL;DR: ${neutralise(src.tldr, 1000)}
Key moments:
${moments}
Concepts: ${neutralise(src.concepts.join(', '), 600)}
</source>

JSON:`;
}

/** Lowercase words separated by single spaces, for verbatim-ish matching. */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

function occurs(text: string, phrase: string): boolean {
  const p = words(phrase);
  return p.trim().length > 0 && words(text).includes(p);
}

export function parseFlashcards(raw: string, evidence: { text: string; starts: number[] }): CardDraft[] {
  const m = /[[{][\s\S]*[\]}]/.exec(raw ?? '');
  if (!m) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const list = Array.isArray(obj) ? obj : obj && typeof obj === 'object' ? (obj as Record<string, unknown>).cards : null;
  if (!Array.isArray(list)) return [];
  const out: CardDraft[] = [];
  const seen = new Set<string>();
  for (const x of list.slice(0, 30)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof r[k] === 'string') return (r[k] as string).replace(/\s+/g, ' ').trim();
      return '';
    };
    const front = pick('q', 'question', 'front');
    const back = pick('a', 'answer', 'back').replace(/[.;,]+$/, '');
    if (!front || !back || front.length > MAX_FRONT || back.length > MAX_BACK) continue;
    if (back.split(' ').length > MAX_ANSWER_WORDS) continue;
    // Invented answers are dropped, and so are cards that give their answer away.
    if (!occurs(evidence.text, back) || occurs(front, back)) continue;
    const key = words(front);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ front, back, startMs: validStart(r.startMs ?? r.start ?? r.t ?? null, evidence.starts) });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cloze cards without a model: blank a concept or tool found in each key moment. */
export function clozeCards(e: Enrichment | null | undefined): CardDraft[] {
  const terms = [...new Set([...(e?.concepts ?? []), ...(e?.tools ?? [])].map((t) => t.trim()).filter((t) => t.length >= 2))]
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return [];
  const sentences: KeyMoment[] = [...keyMomentsOf(e)];
  if (e?.tldr) sentences.push({ text: e.tldr, startMs: null });
  const out: CardDraft[] = [];
  const seen = new Set<string>();
  for (const k of sentences) {
    const text = k.text.replace(/\s+/g, ' ').trim();
    if (text.length < 12 || text.length > MAX_FRONT) continue;
    for (const term of terms) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(term)})(?=$|[^\\p{L}\\p{N}])`, 'iu');
      const hit = re.exec(text);
      if (!hit) continue;
      const answer = hit[2];
      const start = hit.index + hit[1].length;
      const front = `${text.slice(0, start)}_____${text.slice(start + answer.length)}`;
      // The blank must leave enough context to be answerable.
      if (front.replace('_____', '').trim().split(/\s+/).length < 3) continue;
      if (seen.has(front)) break;
      seen.add(front);
      out.push({ front, back: answer, startMs: k.startMs ?? null });
      break;
    }
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

const DAY = 86400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** SM-2-lite: "again" relearns in 10 minutes; the others grow the interval by the card's ease. */
export function schedule(card: Pick<CardSchedule, 'intervalDays' | 'ease' | 'reps' | 'lapses'>, grade: Grade, now: Date): CardSchedule {
  let ease = Number.isFinite(card.ease) && card.ease > 0 ? card.ease : 2.5;
  const prev = Math.max(0, card.intervalDays || 0);
  let reps = card.reps || 0;
  let lapses = card.lapses || 0;
  let interval: number;
  if (grade === 'again') {
    ease = Math.max(1.3, ease - 0.2);
    lapses += 1;
    reps = 0;
    return { dueAt: new Date(now.getTime() + 10 * 60_000).toISOString(), intervalDays: 0, ease: round2(ease), reps, lapses };
  }
  if (grade === 'hard') {
    ease = Math.max(1.3, ease - 0.15);
    interval = reps === 0 ? 1 : Math.max(1, prev * 1.2);
  } else if (grade === 'good') {
    interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(prev + 1, prev * ease);
  } else {
    ease += 0.15;
    interval = reps === 0 ? 3 : Math.max(prev + 2, prev * ease * 1.3);
  }
  reps += 1;
  interval = Math.min(3650, round2(interval));
  return { dueAt: new Date(now.getTime() + interval * DAY).toISOString(), intervalDays: interval, ease: round2(ease), reps, lapses };
}
