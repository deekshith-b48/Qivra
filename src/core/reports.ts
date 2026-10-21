/**
 * Daily / weekly / topic / selection / collection report builder (Markdown + plain text).
 * Every statement is derived from saved items; AI-written prose is included
 * only when a model actually produced it, and is labelled with provider/model.
 */

import type { DateRange } from './dates';
import { formatTimestamp } from './transcripts';
import type { Enrichment } from './enrich';
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

/** Pairs of sources that share tools/repos/tags — evidence-based connections only. */
export function connections(sources: ReportSource[]): { a: number; b: number; shared: string[] }[] {
  const out: { a: number; b: number; shared: string[] }[] = [];
  const keys = (s: ReportSource) => new Set([...(s.enrichment?.tools ?? []), ...(s.enrichment?.repos ?? []), ...s.tags]);
  for (let i = 0; i < sources.length; i++) {
    const ki = keys(sources[i]);
    for (let j = i + 1; j < sources.length; j++) {
      const shared = [...keys(sources[j])].filter((k) => ki.has(k));
      if (shared.length >= 1) out.push({ a: i, b: j, shared: shared.slice(0, 5) });
    }
  }
  return out.sort((x, y) => y.shared.length - x.shared.length).slice(0, 10);
}

export function buildReport(input: ReportInput): BuiltReport {
  const { sources, range } = input;
  const name = input.kind === 'collection' ? input.collection?.name ?? input.topic : input.topic;
  const title = reportTitle(input.kind, range, name);
  const L: string[] = [];
  L.push(`# ${title}`, '');
  L.push(`- **Generated:** ${input.generatedAt}`);
  L.push(`- **Date range:** ${range.label} (${range.startIso} → ${range.endIso})`);
  L.push(`- **Timezone:** ${range.timezone}`);
  if (input.collection) L.push(`- **Collection:** ${esc(input.collection.name)}`);
  else if (input.topic) L.push(`- **Topic filter:** ${input.topic}`);
  L.push(`- **Items covered:** ${sources.length}`, '');

  // 2. Executive summary
  L.push('## Executive summary', '');
  const clusters = topicClusters(sources);
  if (input.ai?.executiveSummary) {
    L.push(input.ai.executiveSummary.trim(), '');
    L.push(`> _AI-generated by ${input.ai.provider}${input.ai.model ? ` (${input.ai.model})` : ''}. Citations like [S1] refer to the numbered sources below; verify before relying on it._`, '');
  } else if (sources.length) {
    const byType = new Map<string, number>();
    for (const s of sources) byType.set(SOURCE_LABELS[s.sourceType] ?? s.sourceType, (byType.get(SOURCE_LABELS[s.sourceType]) ?? 0) + 1);
    const typeText = [...byType.entries()].map(([t, n]) => `${n} ${t}`).join(', ');
    L.push(`You saved ${sources.length} item(s) (${typeText})${clusters.length ? `, mostly about ${clusters.slice(0, 3).map((c) => c.tag).join(', ')}` : ''}.`, '');
    L.push(`> _Computed from your saved metadata — no AI model was used${input.aiUnavailableReason ? ` (${input.aiUnavailableReason})` : ''}._`, '');
  } else {
    L.push('No items were saved in this period.', '');
  }

  // 3. Topic clusters
  L.push('## Topic clusters', '');
  if (clusters.length) for (const c of clusters) L.push(`- **${c.tag}** — ${c.ids.length} item(s): ${c.ids.map((id) => `S${sources.findIndex((s) => s.id === id) + 1}`).join(', ')}`);
  else L.push('- No tags yet. Tag items or run enrichment to build clusters.');
  L.push('');

  // 4. Important learning points
  L.push('## Important learning points', '');
  const points: string[] = [];
  sources.forEach((s, i) => {
    for (const kp of (s.enrichment?.keyPoints ?? []).slice(0, 2)) points.push(`- ${esc(kp)} [S${i + 1}]`);
  });
  if (points.length) L.push(...points.slice(0, 15));
  else L.push('- No key points extracted yet.');
  L.push('');

  // 5 & 6. Per-source summaries with timestamps
  L.push('## Sources', '');
  if (!sources.length) L.push('_No sources in range._', '');
  sources.forEach((s, i) => {
    L.push(`### S${i + 1}. ${esc(s.title || s.url || 'Untitled')}`);
    if (s.url) L.push(`- **URL:** <${s.url}>`);
    L.push(`- **Type:** ${SOURCE_LABELS[s.sourceType] ?? s.sourceType} · **Saved:** ${s.capturedAt}${s.language !== 'und' ? ` · **Language:** ${s.language}` : ''}`);
    if (s.tags.length) L.push(`- **Tags:** ${s.tags.join(', ')}`);
    if (s.summary) L.push(`- **Summary** (${s.summaryOrigin === 'model' ? 'AI-generated' : s.summaryOrigin === 'user' ? 'your edit' : 'extracted'}): ${esc(s.summary)}`);
    if (s.note) L.push(`- **Your note:** ${esc(s.note).slice(0, 500)}`);
    const timed = s.highlights.filter((h) => h.startMs !== null).slice(0, 5);
    if (timed.length) {
      L.push('- **Transcript moments:**');
      for (const h of timed) L.push(`  - \`${formatTimestamp(h.startMs)}\` ${esc(h.text).slice(0, 160)}`);
    }
    if (s.transcriptLanguages.length) L.push(`- **Transcripts:** ${s.transcriptLanguages.join(', ')}`);
    L.push('');
  });

  // 7. Commands, tools, repositories
  L.push('## Tools, repositories and commands', '');
  const tools = new Set<string>();
  const repos = new Set<string>();
  const cmds = new Map<string, { destructive: boolean; reason?: string; src: number }>();
  sources.forEach((s, i) => {
    s.enrichment?.tools.forEach((t) => tools.add(t));
    s.enrichment?.repos.forEach((r) => repos.add(r));
    s.enrichment?.commands.forEach((c) => cmds.has(c.command) || cmds.set(c.command, { destructive: c.destructive, reason: c.reason, src: i + 1 }));
  });
  L.push(`- **Tools & frameworks:** ${tools.size ? [...tools].sort().join(', ') : 'none extracted'}`);
  L.push(`- **Repositories:** ${repos.size ? [...repos].sort().map((r) => `[${r}](https://github.com/${r})`).join(', ') : 'none extracted'}`);
  if (cmds.size) {
    L.push('- **Commands** (copied from sources, never executed — review before running):');
    for (const [c, meta] of [...cmds.entries()].slice(0, 25)) {
      L.push(`  - \`${c}\` [S${meta.src}]${meta.destructive ? ` ⚠️ **Potentially destructive:** ${meta.reason}` : ''}`);
    }
  } else L.push('- **Commands:** none extracted');
  L.push('');

  // 8. Connections
  L.push('## Connections between sources', '');
  const conns = connections(sources);
  if (conns.length) for (const c of conns) L.push(`- S${c.a + 1} ↔ S${c.b + 1}: both mention ${c.shared.join(', ')}`);
  else L.push('- No shared tools, repositories or tags were found between these sources.');
  L.push('');

  // 9. Next actions
  L.push('## Recommended next actions', '');
  const actions: string[] = [];
  const missing = sources.filter((s) => !s.hasTranscript && ['youtube', 'instagram', 'podcast'].includes(s.sourceType));
  if (missing.length) actions.push(`- Import captions or a transcript for ${missing.length} video/audio item(s) (S${missing.map((m) => sources.indexOf(m) + 1).join(', S')}).`);
  const actionItems = sources.flatMap((s, i) => (s.enrichment?.actionItems ?? []).slice(0, 2).map((a) => `- ${esc(a)} [S${i + 1}]`));
  actions.push(...actionItems.slice(0, 8));
  if (repos.size) actions.push(`- Review the ${repos.size} saved repositor${repos.size === 1 ? 'y' : 'ies'} and star or clone the ones you will use.`);
  if (!actions.length) actions.push(sources.length ? '- Add notes or tags to connect these items to your projects.' : '- Save something worth learning today.');
  L.push(...actions, '');

  // 10. Coverage limitations
  L.push('## Coverage and limitations', '');
  const noTranscript = sources.filter((s) => !s.hasTranscript);
  if (noTranscript.length) {
    L.push(`- ${noTranscript.length} item(s) have no transcript; their content is represented only by title, notes and metadata:`);
    for (const s of noTranscript) L.push(`  - S${sources.indexOf(s) + 1}: ${esc(s.title || s.url || s.id)}`);
  } else if (sources.length) L.push('- Every item in this report has a transcript.');
  L.push('- Instagram and YouTube media are not downloaded by Qivra; only captions, metadata and transcripts you imported are used.');
  L.push('');

  // 11. Provider info
  L.push('## Generation details', '');
  L.push(input.ai ? `- AI provider: ${input.ai.provider}${input.ai.model ? ` · model: ${input.ai.model}` : ''}` : '- AI provider: none (report built from saved data only)');
  L.push(`- Generated by Qivra on ${input.generatedAt}`, '');

  return { title, markdown: L.join('\n'), filename: reportFilename(input.kind, range, name) };
}

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
