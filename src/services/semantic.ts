/**
 * Semantic features on top of stored embeddings: "Related" items, near-duplicate
 * detection, meaning-based search, and keeping embeddings up to date. Vectors come
 * from the configured embedding model — by default the paired server's local,
 * multilingual model (nothing leaves your network).
 */

import { snippet } from '../core/search';
import { centroids, type ChunkVector, NEAR_DUPLICATE, parseExpansion, rankChunks, similarItemIds } from '../core/semantic';
import { languageName } from '../core/language';
import type { Item } from '../db/types';
import { aiInfo, loadEmbedder, loadProvider } from './ai';
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

/**
 * Search by meaning: items whose content is close to the query, even with no shared words.
 * With an embedding model this compares vectors; otherwise the chat model rewrites the query
 * (synonyms, translations) and the on-phone index is searched with each phrase.
 */
export async function searchByMeaning(query: string, k = 12, signal?: AbortSignal): Promise<MeaningHit[]> {
  const { provider, embeddingModel } = await loadEmbedder();
  if (!query.trim()) return [];
  if (!provider?.embed || !embeddingModel) return searchByExpansion(query.trim(), k, signal);
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

const EXPANSION_TTL_MS = 7 * 24 * 3_600_000;

/** Up to 6 phrases that mean the same as `query`, in the library's languages (cached for a week). */
export async function expandQuery(query: string, signal?: AbortSignal): Promise<string[]> {
  const repo = await getRepo();
  const key = `qx.${query.toLowerCase().slice(0, 100)}`;
  const hit = await repo.getJson<{ at: number; terms: string[] } | null>(key, null);
  if (hit && Date.now() - hit.at < EXPANSION_TTL_MS) return hit.terms;
  const { provider } = await loadProvider();
  if (!provider) return [];
  const langs = (await repo.db.all<{ language: string }>(
    `SELECT language FROM items WHERE deleted = 0 AND language NOT IN ('und', '') GROUP BY language ORDER BY COUNT(*) DESC LIMIT 4`,
  )).map((r) => languageName(r.language));
  const into = [...new Set(['English', ...langs])].join(', ');
  const res = await provider.chat([
    { role: 'system', content: 'You rewrite search queries for a personal library. Reply with only a JSON array of strings.' },
    { role: 'user', content: `Query: ${JSON.stringify(query)}\nGive up to 6 short search phrases (1–4 words) with the same or a closely related meaning, including translations into ${into}, each in its usual script.` },
  ], { maxTokens: 600, temperature: 0, signal });
  const terms = parseExpansion(res.content, query);
  await repo.setJson(key, { at: Date.now(), terms });
  return terms;
}

async function searchByExpansion(query: string, k: number, signal?: AbortSignal): Promise<MeaningHit[]> {
  if (query.length < 4) return [];
  const terms = await expandQuery(query, signal).catch(() => []);
  const repo = await getRepo();
  const by = new Map<string, MeaningHit>();
  for (const [i, term] of terms.entries()) {
    for (const ch of await repo.searchChunks(term, { limit: 20 }).catch(() => [])) {
      const hit = by.get(ch.itemId) ?? { itemId: ch.itemId, score: 1 - i * 0.1, passages: [] };
      if (hit.passages.length < 2) hit.passages.push({ text: snippet(ch.text, term), startMs: ch.startMs, kind: ch.kind, language: ch.language });
      by.set(ch.itemId, hit);
    }
    if (by.size >= k) break;
  }
  return [...by.values()].slice(0, k);
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
