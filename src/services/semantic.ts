/**
 * Semantic features on top of stored embeddings: "Related" items, near-duplicate
 * detection, meaning-based search, and keeping embeddings up to date. Vectors come
 * from the configured embedding model — by default the paired server's local,
 * multilingual model (nothing leaves your network).
 */

import { centroids, type ChunkVector, NEAR_DUPLICATE, rankChunks, similarItemIds } from '../core/semantic';
import type { Item } from '../db/types';
import { aiInfo, loadProvider } from './ai';
import { getRepo } from './db';
import { emit, subscribe } from './events';

let cache: { model: string; rows: Promise<ChunkVector[]> } | null = null;
// New embeddings and deletions both emit 'items', so the cached vectors never go stale.
subscribe((topic) => { if (topic === 'items') cache = null; });

/** Every stored vector for `model`, parsed once and reused until the library changes. */
export async function embeddingRows(model: string): Promise<ChunkVector[]> {
  if (cache?.model !== model) {
    const rows = getRepo().then((repo) => repo.allEmbeddings(model));
    cache = { model, rows };
    rows.catch(() => { if (cache?.rows === rows) cache = null; });
  }
  return cache.rows;
}

export interface SimilarItem {
  item: Item;
  score: number;
  /** Very likely the same content (re-shared, or saved twice from different apps). */
  nearDuplicate: boolean;
}

export async function similarItems(itemId: string, k = 4): Promise<SimilarItem[]> {
  const model = (await aiInfo()).embeddingModel;
  if (!model) return [];
  const rows = await embeddingRows(model);
  const best = similarItemIds(itemId, centroids(rows), k);
  if (!best.length) return [];
  const repo = await getRepo();
  const items = new Map((await repo.itemsByIds(best.map((b) => b.itemId))).map((i) => [i.id, i]));
  return best.filter((b) => items.has(b.itemId)).map((b) => ({ item: items.get(b.itemId)!, score: b.score, nearDuplicate: b.score >= NEAR_DUPLICATE }));
}

export interface MeaningHit {
  itemId: string;
  score: number;
  passages: { text: string; startMs: number | null; kind: string; language: string | null }[];
}

/** Search by meaning: items whose content is close to the query, even with no shared words. */
export async function searchByMeaning(query: string, k = 12, signal?: AbortSignal): Promise<MeaningHit[]> {
  const { provider, embeddingModel } = await loadProvider();
  if (!provider?.embed || !embeddingModel || !query.trim()) return [];
  const repo = await getRepo();
  const rows = await embeddingRows(embeddingModel);
  if (!rows.length) return [];
  const [qv] = await provider.embed([query.trim()], signal);
  const ranked = rankChunks(qv, rows, k * 3, 2);
  const by = new Map<string, MeaningHit>();
  for (const r of ranked) {
    if (!by.has(r.itemId) && by.size >= k) continue; // enough items; only add passages to those we have
    const chunk = await repo.getChunk(r.chunkId);
    if (!chunk) continue;
    const hit = by.get(r.itemId) ?? { itemId: r.itemId, score: r.score, passages: [] };
    hit.passages.push({ text: chunk.text.slice(0, 220), startMs: chunk.startMs, kind: chunk.kind, language: chunk.language });
    by.set(r.itemId, hit);
  }
  return [...by.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Queue embedding work for anything not embedded yet (new model, older items, backfill). */
export async function ensureEmbeddings(): Promise<boolean> {
  const model = (await aiInfo()).embeddingModel;
  if (!model) return false;
  const repo = await getRepo();
  if (!(await repo.chunksMissingEmbeddings(model, 1)).length) return false;
  await repo.enqueueJob({ id: 'job_embed', kind: 'embed', retry: true, maxAttempts: 3 });
  emit('jobs');
  return true;
}
