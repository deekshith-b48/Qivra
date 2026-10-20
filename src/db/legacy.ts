/**
 * One-time, non-destructive import of data left by the SuperBrain app.
 *
 * Qivra keeps the SuperBrain application id (com.superbrain.mobile), so an
 * in-place upgrade still has SuperBrain's `superbrain_local.db` (posts cache)
 * and AsyncStorage collections. They are copied into qivra.db; the old files
 * are left untouched so a downgrade or manual export remains possible.
 */

import { analyzeUrl } from '../core/url';
import type { Repo } from './repo';

export interface LegacyPost {
  shortcode: string;
  url?: string | null;
  username?: string | null;
  content_type?: string | null;
  analyzed_at?: string | null;
  title?: string | null;
  summary?: string | null;
  tags?: string | string[] | null;
  category?: string | null;
  thumbnail?: string | null;
}

export interface LegacyCollection {
  id: string;
  name: string;
  icon?: string;
  postIds?: string[];
  createdAt?: string;
}

export interface LegacyStats {
  posts: number;
  skipped: number;
  collections: number;
}

export function legacyItemId(shortcode: string): string {
  return `sb_${shortcode.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 70)}`;
}

export async function importLegacy(repo: Repo, data: { posts: LegacyPost[]; collections: LegacyCollection[] }): Promise<LegacyStats> {
  const stats: LegacyStats = { posts: 0, skipped: 0, collections: 0 };
  if ((await repo.getMeta('app.legacyImported')) === '1') return stats;
  const idMap = new Map<string, string>();
  for (const p of data.posts) {
    if (!p.shortcode) {
      stats.skipped++;
      continue;
    }
    const info = p.url ? analyzeUrl(p.url) : null;
    let tags: string[] = [];
    if (Array.isArray(p.tags)) tags = p.tags;
    else if (typeof p.tags === 'string') {
      try {
        tags = JSON.parse(p.tags);
      } catch {
        tags = [];
      }
    }
    if (p.category && !tags.includes(p.category)) tags.push(p.category);
    const id = legacyItemId(p.shortcode);
    const { item, duplicate } = await repo.createItem({
      id,
      sourceType: info?.sourceType ?? (p.content_type === 'youtube' ? 'youtube' : p.content_type === 'instagram' ? 'instagram' : 'web'),
      url: info?.url ?? p.url ?? null,
      dedupeKey: info?.dedupeKey ?? null,
      title: p.title ?? '',
      author: p.username ?? '',
      origin: 'superbrain',
      status: p.summary || p.title ? 'READY' : 'CAPTURED',
      capturedAt: normalizeTs(p.analyzed_at),
      tags: tags.filter((t) => typeof t === 'string'),
    });
    idMap.set(p.shortcode, item.id);
    if (duplicate) {
      stats.skipped++;
      continue;
    }
    // SuperBrain summaries were produced by its AI pipeline → provenance 'server'.
    await repo.db.run(
      `UPDATE items SET summary = ?, summary_origin = ?, thumbnail_url = ?, synced_local_rev = local_rev,
         sync_status = 'local_only' WHERE id = ?`,
      [p.summary ?? '', p.summary ? 'server' : 'none', p.thumbnail && /^https?:/.test(p.thumbnail) ? p.thumbnail : '', item.id],
    );
    await repo.reindexMeta(item.id);
    stats.posts++;
  }
  for (const c of data.collections) {
    if (!c.id || !c.name) continue;
    const existing = await repo.getCollection(c.id);
    const col = existing ?? (await repo.createCollection(c.name, c.icon === 'time' ? 'clock' : 'folder', c.id));
    const members = (c.postIds ?? []).map((sc) => idMap.get(sc)).filter((x): x is string => !!x);
    if (members.length) await repo.addToCollection(col.id, members);
    stats.collections++;
  }
  await repo.setMeta('app.legacyImported', '1');
  return stats;
}

function normalizeTs(v: string | null | undefined): string {
  if (!v) return new Date().toISOString();
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}
