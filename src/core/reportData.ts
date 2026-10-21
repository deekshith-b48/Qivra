/**
 * Picks the items and date range for a report request and turns items into
 * `ReportSource`s. Depends only on the repository, so it runs under Node in tests.
 */

import type { Repo } from '../db/repo';
import type { Item } from '../db/types';
import { dayRange, localDate, rangeFor, type DateRange } from './dates';
import type { ReportKind, ReportSource } from './reports';

export interface ReportRequest {
  kind: ReportKind;
  topic?: string;
  itemIds?: string[];
  /** Required for `collection` reports. */
  collectionId?: string;
  custom?: { from: string; to: string };
  useAi?: boolean;
}

export interface ReportSelection {
  range: DateRange;
  items: Item[];
  collection?: { id: string; name: string };
}

export const COLLECTION_REPORT_LIMIT = 300;

export async function selectReportItems(repo: Repo, req: ReportRequest, nowMs: number, tz: string): Promise<ReportSelection> {
  if (req.kind === 'collection') {
    const col = req.collectionId ? await repo.getCollection(req.collectionId) : null;
    if (!col) throw new Error('That collection no longer exists.');
    const items = await repo.listItems({ collectionId: col.id }, 'newest', COLLECTION_REPORT_LIMIT);
    // A collection is not date-bound: the range spans its oldest to newest saved item.
    const today = localDate(nowMs, tz);
    const days = items.map((i) => localDate(Date.parse(i.capturedAt), tz)).sort();
    const first = days[0] ?? today;
    const last = days[days.length - 1] ?? today;
    return { range: dayRange(first, last, tz, first === last ? first : `${first} – ${last}`), items, collection: { id: col.id, name: col.name } };
  }

  let range: DateRange;
  if (req.custom) range = rangeFor('custom', nowMs, tz, req.custom);
  else if (req.kind === 'yesterday') range = rangeFor('yesterday', nowMs, tz);
  else if (req.kind === 'weekly') range = rangeFor('week', nowMs, tz);
  else if (req.kind === 'daily') range = rangeFor('today', nowMs, tz);
  else range = rangeFor('last30', nowMs, tz);

  let items = req.kind === 'selection' && req.itemIds?.length ? await repo.itemsByIds(req.itemIds) : await repo.itemsInRange(range.startIso, range.endIso, 300);
  if ((req.kind === 'topic' || req.kind === 'developer') && req.topic?.trim()) {
    const hits = await repo.searchChunks(req.topic, { itemIds: items.map((i) => i.id), limit: 500 });
    const ids = new Set(hits.map((h) => h.itemId));
    items = items.filter((i) => ids.has(i.id));
  }
  if (req.kind === 'developer') items = items.filter((i) => (i.enrichment?.tools.length ?? 0) + (i.enrichment?.repos.length ?? 0) + (i.enrichment?.commands.length ?? 0) > 0 || i.sourceType === 'github');
  return { range, items };
}

export async function toReportSources(repo: Repo, items: Item[]): Promise<ReportSource[]> {
  const sources: ReportSource[] = [];
  for (const it of items) {
    const transcripts = await repo.listTranscripts(it.id);
    const highlights: { startMs: number | null; text: string }[] = [];
    const ts = it.enrichment?.timestamps ?? [];
    if (ts.length) highlights.push(...ts.map((t) => ({ startMs: t.ms, text: t.label })));
    else if (transcripts[0]?.hasTimestamps) highlights.push(...(await repo.getSegments(transcripts[0].id)).filter((x) => x.startMs !== null).slice(0, 3));
    sources.push({
      id: it.id, title: it.title, url: it.url, sourceType: it.sourceType, capturedAt: it.capturedAt, summary: it.summary, summaryOrigin: it.summaryOrigin,
      note: it.note, tags: it.tags, language: it.language, enrichment: it.enrichment, hasTranscript: transcripts.length > 0,
      transcriptLanguages: transcripts.map((t) => `${t.language}${t.kind === 'translation' ? ' (translation)' : ''}`), highlights,
    });
  }
  return sources;
}
