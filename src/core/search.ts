/**
 * Search query building for SQLite FTS5 and library filters.
 * User text is never interpolated into SQL: FTS terms are quoted and all
 * filter values are bound parameters.
 */

import type { SourceType } from './url';
import type { ItemStatus } from './status';

export interface LibraryFilter {
  text?: string;
  sourceTypes?: SourceType[];
  statuses?: ItemStatus[];
  languages?: string[];
  tags?: string[];
  collectionId?: string;
  fromIso?: string;
  toIso?: string;
  archived?: boolean; // default false
  hasTranscript?: boolean;
}

export type SortKey = 'newest' | 'oldest' | 'title' | 'updated';

/** Turn free text into a safe FTS5 MATCH expression (AND of prefix terms). */
export function buildFtsQuery(text: string): string | null {
  const tokens = (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu) ?? [])
    .map((t) => t.replace(/[.-]+$/, ''))
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

/** Same terms joined with OR — used as a fallback when the AND query finds nothing. */
export function buildFtsOrQuery(text: string): string | null {
  const and = buildFtsQuery(text);
  return and ? and.split(' AND ').join(' OR ') : null;
}

export function buildFilterSql(f: LibraryFilter, alias = 'i'): { where: string; params: (string | number)[] } {
  const clauses: string[] = [`${alias}.deleted = 0`];
  const params: (string | number)[] = [];
  clauses.push(`${alias}.archived = ?`);
  params.push(f.archived ? 1 : 0);
  const inList = (col: string, values: (string | number)[]) => {
    clauses.push(`${col} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  if (f.sourceTypes?.length) inList(`${alias}.source_type`, f.sourceTypes);
  if (f.statuses?.length) inList(`${alias}.status`, f.statuses);
  if (f.languages?.length) inList(`${alias}.language`, f.languages);
  if (f.fromIso) {
    clauses.push(`${alias}.captured_at >= ?`);
    params.push(f.fromIso);
  }
  if (f.toIso) {
    clauses.push(`${alias}.captured_at < ?`);
    params.push(f.toIso);
  }
  for (const tag of f.tags ?? []) {
    clauses.push(`EXISTS (SELECT 1 FROM item_tags t WHERE t.item_id = ${alias}.id AND t.tag = ?)`);
    params.push(tag.toLowerCase());
  }
  if (f.collectionId) {
    clauses.push(`EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_id = ${alias}.id AND ci.collection_id = ?)`);
    params.push(f.collectionId);
  }
  if (f.hasTranscript !== undefined) {
    clauses.push(`${f.hasTranscript ? '' : 'NOT '}EXISTS (SELECT 1 FROM transcripts tr WHERE tr.item_id = ${alias}.id)`);
  }
  return { where: clauses.join(' AND '), params };
}

export function orderBySql(sort: SortKey, alias = 'i'): string {
  switch (sort) {
    case 'oldest':
      return `${alias}.captured_at ASC, ${alias}.id ASC`;
    case 'title':
      return `${alias}.title COLLATE NOCASE ASC, ${alias}.id ASC`;
    case 'updated':
      return `${alias}.updated_at DESC, ${alias}.id DESC`;
    default:
      return `${alias}.captured_at DESC, ${alias}.id DESC`;
  }
}

/** Reciprocal-rank fusion of keyword and (optional) semantic result lists. */
export function reciprocalRankFusion(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Highlight-free snippet around the first matching term. */
export function snippet(text: string, query: string, radius = 120): string {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  const low = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = low.indexOf(t);
    if (p !== -1 && (pos === -1 || p < pos)) pos = p;
  }
  if (pos === -1) return text.slice(0, radius * 2).trim();
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
