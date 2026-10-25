/**
 * Daily / weekly / topic / selection / collection report builder (Markdown + plain text).
 * Every statement is derived from saved items; AI-written prose is included
 * only when a model actually produced it, and is labelled with provider/model.
 */

import type { DateRange } from './dates';
import { formatTimestamp } from './transcripts';
import { type Enrichment, firstSentence, keyMomentsOf } from './enrich';
import { SOURCE_LABELS, type SourceType } from './url';

export type ReportKind = 'daily' | 'yesterday' | 'weekly' | 'topic' | 'selection' | 'developer' | 'collection';

export interface ReportSource {
  id: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
  capturedAt: string;
  summary: string;
  summaryOrigin: string;
  note: string;
  tags: string[];
  language: string;
  enrichment: Enrichment | null;
  transcriptLanguages: string[];
  hasTranscript: boolean;
  highlights: { startMs: number | null; text: string }[];
}

export interface ReportInput {
  kind: ReportKind;
  range: DateRange;
  generatedAt: string;
  topic?: string;
  /** Set for `collection` reports. */
  collection?: { id: string; name: string };
  sources: ReportSource[];
  ai?: { executiveSummary: string; provider: string; model: string | null } | null;
  aiUnavailableReason?: string | null;
}

export interface BuiltReport {
  title: string;
  markdown: string;
  filename: string;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic';
}

/** For `collection` reports, `topic` is the collection name. */
export function reportFilename(kind: ReportKind, range: DateRange, topic?: string): string {
  switch (kind) {
    case 'collection':
      return `Qivra-Collection-Report-${slug(topic ?? 'collection')}-${range.lastDay}.md`;
    case 'daily':
    case 'yesterday':
      return `Qivra-Daily-Report-${range.firstDay}.md`;
    case 'weekly':
      return `Qivra-Weekly-Report-${range.firstDay}_to_${range.lastDay}.md`;
    case 'selection':
      return `Qivra-Selection-Report-${range.lastDay}.md`;
    case 'developer':
      return `Qivra-Developer-Report-${slug(topic ?? 'dev')}-${range.lastDay}.md`;
    default:
      return `Qivra-Topic-Report-${slug(topic ?? 'topic')}-${range.lastDay}.md`;
  }
}

export function reportTitle(kind: ReportKind, range: DateRange, topic?: string): string {
  switch (kind) {
    case 'collection':
      return `Collection: ${topic ?? 'Untitled'}`;
    case 'daily':
    case 'yesterday':
      return `Qivra Daily Report — ${range.firstDay}`;
    case 'weekly':
      return `Qivra Weekly Learning Report — ${range.firstDay} to ${range.lastDay}`;
    case 'selection':
      return 'Qivra Report — Selected items';
    case 'developer':
      return `Qivra Developer Report — ${topic ?? 'tools & repositories'}`;
    default:
      return `Qivra Topic Report — ${topic ?? 'All topics'}`;
  }
}

const esc = (s: string) => s.replace(/\r?\n/g, ' ').trim();

export function topicClusters(sources: ReportSource[], max = 8): { tag: string; ids: string[] }[] {
  const map = new Map<string, string[]>();
  for (const s of sources) for (const t of s.tags) map.set(t, [...(map.get(t) ?? []), s.id]);
  return [...map.entries()].map(([tag, ids]) => ({ tag, ids })).sort((a, b) => b.ids.length - a.ids.length || a.tag.localeCompare(b.tag)).slice(0, max);
}

/** Plural nouns for the "At a glance" line, in display order. */
const GLANCE_TYPES: [string, string, SourceType[]][] = [
  ['video', 'videos', ['youtube', 'instagram']],
  ['podcast', 'podcasts', ['podcast']],
  ['post', 'posts', ['x']],
  ['page', 'pages', ['web']],
  ['repo', 'repos', ['github']],
  ['note', 'notes', ['note', 'text']],
  ['file', 'files', ['file']],
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** Brackets in a title would break `[title](url)` and `[S1]` parsing. */
const label = (s: ReportSource) => esc(s.title || s.url || 'Untitled').replace(/\[/g, '(').replace(/\]/g, ')');
/** `[01:05]` renders as a timestamp pill in the app's Markdown. */
const stamp = (ms: number) => `[${formatTimestamp(ms).padStart(5, '0')}]`;

export function glanceLine(sources: ReportSource[]): string {
  const parts = GLANCE_TYPES.map(([one, many, types]) => [sources.filter((s) => types.includes(s.sourceType)).length, one, many] as const)
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => plural(n, one, many));
  const other = sources.filter((s) => !GLANCE_TYPES.some(([, , t]) => t.includes(s.sourceType))).length;
  if (other) parts.push(`${other} other`);
  parts.push(plural(sources.filter((s) => s.hasTranscript).length, 'with transcript', 'with transcripts'));
  return parts.join(' · ');
}

/** Reads the counts back from a built report (the header card's stat tiles). Old reports return zeros. */
export function parseGlance(markdown: string): { videos: number; transcripts: number } {
  const line = /^\*\*At a glance:\*\* (.*)$/m.exec(markdown)?.[1] ?? '';
  const n = (re: RegExp) => Number(re.exec(line)?.[1] ?? 0);
  return { videos: n(/(\d+) videos?\b/), transcripts: n(/(\d+) with transcripts?\b/) };
}

export function buildReport(input: ReportInput): BuiltReport {
  const { sources, range } = input;
  const name = input.kind === 'collection' ? input.collection?.name ?? input.topic : input.topic;
  const title = reportTitle(input.kind, range, name);
  const sid = (s: ReportSource) => `[S${sources.indexOf(s) + 1}]`;
  const L: string[] = [];

  // Header
  L.push(`# ${title}`, '');
  const scope = input.collection ? ` · Collection: ${esc(input.collection.name)}` : input.topic ? ` · Topic: ${esc(input.topic)}` : '';
  L.push(`_${range.label}${scope} · ${plural(sources.length, 'item', 'items')}_`, '');
  if (sources.length) L.push(`**At a glance:** ${glanceLine(sources)}`, '');

  // Summary
  L.push('## Summary', '');
  const clusters = topicClusters(sources);
  if (input.ai?.executiveSummary) {
    L.push(input.ai.executiveSummary.trim(), '');
    L.push(`> _AI-generated by ${input.ai.provider}${input.ai.model ? ` (${input.ai.model})` : ''}. Citations like [S1] point to the sources below; verify before relying on it._`, '');
  } else if (sources.length) {
    L.push(`You saved ${plural(sources.length, 'item', 'items')}${clusters.length ? `, mostly about ${clusters.slice(0, 3).map((c) => c.tag).join(', ')}` : ''}.`, '');
    L.push(`> _Computed from your saved data — no AI model was used${input.aiUnavailableReason ? ` (${input.aiUnavailableReason})` : ''}._`, '');
  } else {
    L.push('No items were saved in this period.', '');
  }

  // Key takeaways
  const points = sources.flatMap((s) => (s.enrichment?.keyPoints ?? []).slice(0, 2).map((kp) => `- ${cut(esc(kp), 160)} ${sid(s)}`)).slice(0, 10);
  if (points.length) L.push('## Key takeaways', '', ...points, '');

  // Topics
  if (clusters.length) {
    L.push('## Topics', '');
    for (const c of clusters) {
      const items = c.ids.map((id) => sources.find((s) => s.id === id)).filter((s): s is ReportSource => !!s);
      const shown = items.slice(0, 4).map((s) => `${cut(label(s), 60)} ${sid(s)}`).join(' · ');
      L.push(`- **${c.tag}** — ${shown}${items.length > 4 ? ` · +${items.length - 4} more` : ''}`);
    }
    L.push('');
  }

  // By source: one compact block per item
  if (sources.length) {
    L.push('## By source', '');
    for (const s of sources) {
      const type = SOURCE_LABELS[s.sourceType] ?? s.sourceType;
      L.push(`${sid(s)} **${type}** · ${s.url ? `[${label(s)}](${s.url})` : `**${label(s)}**`}`);
      const tldr = s.enrichment?.tldr || (s.summary ? firstSentence(s.summary) : '') || (s.note ? firstSentence(s.note) : '');
      if (tldr) L.push('', `${cut(esc(tldr), 220)}${s.summaryOrigin === 'model' || s.enrichment?.origin === 'model' ? ' _(AI)_' : ''}`);
      const timed = keyMomentsOf(s.enrichment).filter((m) => m.startMs !== null);
      const moments = (timed.length ? timed : s.highlights.filter((h) => h.startMs !== null)).slice(0, 3);
      if (moments.length) L.push('', ...moments.map((m) => `- ${stamp(m.startMs ?? 0)} ${cut(esc(m.text), 140)}`));
      L.push('');
    }
  }

  // Tools & commands (only when present)
  const tools = new Set<string>();
  const repos = new Set<string>();
  const cmds = new Map<string, { destructive: boolean; reason?: string; src: string }>();
  for (const s of sources) {
    s.enrichment?.tools.forEach((t) => tools.add(t));
    s.enrichment?.repos.forEach((r) => repos.add(r));
    s.enrichment?.commands.forEach((c) => cmds.has(c.command) || cmds.set(c.command, { destructive: c.destructive, reason: c.reason, src: sid(s) }));
  }
  if (tools.size || repos.size || cmds.size) {
    L.push('## Tools & commands', '');
    if (tools.size) L.push(`**Tools:** ${[...tools].sort().join(', ')}`, '');
    if (repos.size) L.push(`**Repositories:** ${[...repos].sort().map((r) => `[${r}](https://github.com/${r})`).join(', ')}`, '');
    if (cmds.size) {
      L.push('**Commands** — copied from sources, never run. Review before running:', '');
      for (const [c, meta] of [...cmds.entries()].slice(0, 25)) L.push(`- \`${c}\` ${meta.src}${meta.destructive ? ` ⚠️ **Potentially destructive:** ${meta.reason}` : ''}`);
      L.push('');
    }
  }

  // Next steps
  L.push('## Next steps', '');
  const actions: string[] = [];
  const missing = sources.filter((s) => !s.hasTranscript && ['youtube', 'instagram', 'podcast'].includes(s.sourceType));
  if (missing.length) actions.push(`- Add captions or a transcript for ${plural(missing.length, 'video', 'videos')} ${missing.map(sid).join(' ')}.`);
  actions.push(...sources.flatMap((s) => (s.enrichment?.actionItems ?? []).slice(0, 2).map((a) => `- ${cut(esc(a), 160)} ${sid(s)}`)).slice(0, 8));
  if (repos.size) actions.push(`- Review the ${plural(repos.size, 'saved repository', 'saved repositories')} and star or clone the ones you will use.`);
  if (!actions.length) actions.push(sources.length ? '- Add notes or tags to connect these items to your projects.' : '- Save something worth learning today.');
  L.push(...actions, '');

  // Footer: coverage + generation details
  L.push('---', '');
  const noTranscript = sources.filter((s) => !s.hasTranscript);
  const coverage = !sources.length ? 'No saved items in range.'
    : noTranscript.length ? `${plural(noTranscript.length, 'item has', 'items have')} no transcript (${noTranscript.map((s) => `S${sources.indexOf(s) + 1}`).join(', ')}) and ${noTranscript.length === 1 ? 'is' : 'are'} covered by title, notes and metadata only.`
      : 'Every item has a transcript.';
  L.push(`_Coverage: ${coverage} Nothing is invented; transcripts come from captions, Groq Whisper (your key) or your imports._`, '');
  L.push(`_${input.ai ? `AI: ${input.ai.provider}${input.ai.model ? ` (${input.ai.model})` : ''}` : 'No AI model used'} · ${range.timezone} · generated by Qivra on ${input.generatedAt}_`, '');

  return { title, markdown: L.join('\n'), filename: reportFilename(input.kind, range, name) };
}

export interface ReportSection {
  heading: string;
  body: string;
}

/**
 * Splits a report into its parts: the preamble (title, range, at-a-glance), one
 * section per `## ` heading, and the footer after the final `---`.
 */
export function splitReport(markdown: string): { title: string; preamble: string; sections: ReportSection[]; footer: string } {
  // Only the last rule is the footer: an AI summary may contain its own.
  const cutAt = markdown.lastIndexOf('\n---\n');
  const main = cutAt < 0 ? markdown : markdown.slice(0, cutAt);
  const footer = cutAt < 0 ? '' : markdown.slice(cutAt + 5).trim();
  const [head, ...parts] = main.split(/^## /m);
  const title = /^# (.*)$/m.exec(head)?.[1] ?? '';
  const preamble = head.replace(/^# .*$/m, '').trim();
  const sections = parts.map((p) => {
    const nl = p.indexOf('\n');
    return { heading: (nl < 0 ? p : p.slice(0, nl)).trim(), body: nl < 0 ? '' : p.slice(nl + 1).trim() };
  });
  return { title, preamble, sections, footer };
}

/** "By source" body → one Markdown block per item (each starts with its `[S1]` line). */
export const sourceBlocks = (body: string): string[] => body.split(/\n+(?=\[S\d+\] )/).map((b) => b.trim()).filter(Boolean);

/** Markdown → readable plain text (for .txt export and clipboard). */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+(.*)$/gm, (_m, t: string) => `${t}\n${'='.repeat(Math.min(60, t.length))}`)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
