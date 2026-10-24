/**
 * Meaning-based similarity over stored chunk embeddings (pure; unit-tested).
 * Item similarity uses each item's centroid (the normalised mean of its chunk
 * vectors), so a long video and a short post about the same topic still match.
 */

import { cosine } from './search';

export interface ChunkVector {
  chunkId: number;
  itemId: string;
  vector: number[];
}

/**
 * Search phrases from the model's reply to a query-expansion prompt: the first JSON array
 * of strings, trimmed, 1–60 characters, without the query itself or repeats, at most 6.
 */
export function parseExpansion(reply: string, query: string): string[] {
  const m = reply.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set([query.trim().toLowerCase()]);
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (!t || t.length > 60 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 6) break;
  }
  return out;
}

/** Scores at or above this mean "very likely the same thing" (re-shared or duplicate). */
export const NEAR_DUPLICATE = 0.93;
/** Below this, items are not shown as related. */
export const MIN_RELATED = 0.35;

function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function centroids(rows: ChunkVector[]): Map<string, number[]> {
  const sums = new Map<string, { v: number[]; n: number }>();
  for (const r of rows) {
    if (!r.vector.length) continue;
    const cur = sums.get(r.itemId);
    if (!cur) sums.set(r.itemId, { v: [...r.vector], n: 1 });
    else if (cur.v.length === r.vector.length) {
      for (let i = 0; i < cur.v.length; i++) cur.v[i] += r.vector[i];
      cur.n++;
    }
  }
  const out = new Map<string, number[]>();
  for (const [id, { v, n }] of sums) out.set(id, normalise(v.map((x) => x / n)));
  return out;
}

export function similarItemIds(targetId: string, cents: Map<string, number[]>, k = 5, min = MIN_RELATED): { itemId: string; score: number }[] {
  const t = cents.get(targetId);
  if (!t) return [];
  return [...cents.entries()]
    .filter(([id]) => id !== targetId)
    .map(([itemId, v]) => ({ itemId, score: cosine(t, v) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** The best chunks for a query vector, at most `perItem` per item. */
export function rankChunks(query: number[], rows: ChunkVector[], k = 30, perItem = 3, min = 0.25): (ChunkVector & { score: number })[] {
  const scored = rows.map((r) => ({ ...r, score: cosine(query, r.vector) })).filter((r) => r.score >= min).sort((a, b) => b.score - a.score);
  const count = new Map<string, number>();
  const out: (ChunkVector & { score: number })[] = [];
  for (const r of scored) {
    const n = count.get(r.itemId) ?? 0;
    if (n >= perItem) continue;
    count.set(r.itemId, n + 1);
    out.push(r);
    if (out.length >= k) break;
  }
  return out;
}
