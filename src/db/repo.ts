/**
 * Data access for the on-device library. Every write goes through here so
 * revision tracking, sync status and the search index stay consistent.
 */

import type { Enrichment } from '../core/enrich';
import { newId, stableHash } from '../core/ids';
import { buildFilterSql, buildFtsOrQuery, buildFtsQuery, orderBySql, type LibraryFilter, type SortKey } from '../core/search';
import { rulesToFilter, sanitizeRules, type SmartRules } from '../core/smart';
import { backoffMs, transition, type ItemStatus } from '../core/status';
import { chunkSegments, hasTimestamps, segmentsToText, type Segment } from '../core/transcripts';
import type { SqlDriver, SqlExecutor, SqlValue } from './driver';
import type {
  Card, ChunkHit, Citation, Collection, CollectionSuggestion, Conflict, Highlight, Item, ItemMetadata, Job, JobKind, JobStatus, Message, NewItem, Origin, Report,
  SyncStatus, Transcript, TranscriptInput,
} from './types';

type Row = Record<string, unknown>;
type Clock = () => Date;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Fields whose change counts as a user edit that must be synchronised. */
const SYNCED_FIELDS = new Set(['title', 'note', 'summary', 'url', 'author', 'language', 'archived', 'deleted', 'tags']);

export interface ItemPatch {
  title?: string;
  note?: string;
  summary?: string;
  summaryOrigin?: Origin;
  author?: string;
  siteName?: string;
  thumbnailUrl?: string;
  url?: string | null;
  language?: string;
  languageMethod?: Item['languageMethod'];
  enrichment?: Enrichment | null;
  metadata?: ItemMetadata | null;
  archived?: boolean;
}

export class Repo {
  constructor(public db: SqlDriver, private clock: Clock = () => new Date()) {}

  private now(): string {
    return this.clock().toISOString();
  }

  // ── meta / settings ──────────────────────────────────────────────────────
  async getMeta(key: string): Promise<string | null> {
    const r = await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return r?.value ?? null;
  }

  async setMeta(key: string, value: string, ex: SqlExecutor = this.db): Promise<void> {
    await ex.run('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  /** Meta keys starting with `prefix` (e.g. the days a habit was completed). */
  async metaKeys(prefix: string): Promise<string[]> {
    const rows = await this.db.all<{ key: string }>(`SELECT key FROM meta WHERE key LIKE ? ESCAPE '\\'`, [`${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`]);
    return rows.map((r) => r.key);
  }

  /**
   * Dev toolbox: every GitHub repo, tool and command found in the library's summaries,
   * most mentioned first, with the items they came from.
   */
  async devToolbox(limit = 40): Promise<{
    repos: { name: string; count: number; itemIds: string[] }[];
    tools: { name: string; count: number }[];
    commands: { command: string; destructive: boolean; reason: string | null; itemId: string }[];
  }> {
    const src = (path: string) => `json_each(CASE WHEN json_valid(i.enrichment_json) THEN i.enrichment_json ELSE '{}' END, '${path}')`;
    const repos = await this.db.all<Row>(
      `SELECT j.value AS name, COUNT(DISTINCT i.id) AS n, group_concat(DISTINCT i.id) AS ids FROM items i, ${src('$.repos')} j
       WHERE i.deleted = 0 GROUP BY LOWER(j.value) ORDER BY n DESC, name ASC LIMIT ?`, [limit]);
    const tools = await this.db.all<Row>(
      `SELECT j.value AS name, COUNT(DISTINCT i.id) AS n FROM items i, ${src('$.tools')} j
       WHERE i.deleted = 0 GROUP BY LOWER(j.value) ORDER BY n DESC, name ASC LIMIT ?`, [limit]);
    const commands = await this.db.all<Row>(
      `SELECT json_extract(j.value, '$.command') AS command, json_extract(j.value, '$.destructive') AS destructive,
              json_extract(j.value, '$.reason') AS reason, MIN(i.id) AS item_id
       FROM items i, ${src('$.commands')} j WHERE i.deleted = 0 AND json_extract(j.value, '$.command') IS NOT NULL
       GROUP BY command ORDER BY MAX(i.captured_at) DESC LIMIT ?`, [limit * 2.5]); // grouped by tool in the UI, so a longer list stays readable
    return {
      repos: repos.map((r) => ({ name: str(r.name), count: Number(r.n), itemIds: str(r.ids).split(',').filter(Boolean) })),
      tools: tools.map((r) => ({ name: str(r.name), count: Number(r.n) })),
      commands: commands.map((r) => ({ command: str(r.command), destructive: Number(r.destructive) === 1, reason: strOrNull(r.reason), itemId: str(r.item_id) })),
    };
  }

  async getJson<T>(key: string, fallback: T): Promise<T> {
    return parseJson<T>(await this.getMeta(key), fallback);
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.setMeta(key, JSON.stringify(value));
  }

  async syncEnabled(): Promise<boolean> {
    return (await this.getMeta('sync.enabled')) === '1';
  }

  // ── items ────────────────────────────────────────────────────────────────
  private async rowToItem(r: Row, ex: SqlExecutor = this.db): Promise<Item> {
    const tags = await ex.all<{ tag: string }>('SELECT tag FROM item_tags WHERE item_id = ? ORDER BY tag', [str(r.id)]);
    return {
      id: str(r.id),
      sourceType: str(r.source_type) as Item['sourceType'],
      url: strOrNull(r.url),
      dedupeKey: strOrNull(r.dedupe_key),
      title: str(r.title),
      note: str(r.note),
      author: str(r.author),
      siteName: str(r.site_name),
      thumbnailUrl: str(r.thumbnail_url),
      summary: str(r.summary),
      summaryOrigin: str(r.summary_origin) as Origin,
      language: str(r.language) || 'und',
      languageMethod: str(r.language_method) as Item['languageMethod'],
      status: str(r.status) as ItemStatus,
      errorCode: strOrNull(r.error_code),
      errorMessage: strOrNull(r.error_message),
      enrichment: parseJson<Enrichment | null>(r.enrichment_json, null),
      metadata: parseJson<ItemMetadata | null>(r.metadata_json, null),
      origin: str(r.origin) as Item['origin'],
      capturedAt: str(r.captured_at),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      lastViewedAt: strOrNull(r.last_viewed_at),
      favorite: Number(r.favorite) === 1,
      remindAt: strOrNull(r.remind_at),
      archived: Number(r.archived) === 1,
      deleted: Number(r.deleted) === 1,
      localRev: Number(r.local_rev),
      syncedLocalRev: Number(r.synced_local_rev),
      serverRevision: r.server_revision === null || r.server_revision === undefined ? null : Number(r.server_revision),
      syncStatus: str(r.sync_status) as SyncStatus,
      tags: tags.map((t) => t.tag),
    };
  }

  async getItem(id: string, ex: SqlExecutor = this.db): Promise<Item | null> {
    const r = await ex.get<Row>('SELECT * FROM items WHERE id = ?', [id]);
    return r ? this.rowToItem(r, ex) : null;
  }

  async findDuplicate(dedupeKey: string | null): Promise<Item | null> {
    if (!dedupeKey) return null;
    const r = await this.db.get<Row>('SELECT * FROM items WHERE dedupe_key = ? AND deleted = 0 ORDER BY captured_at LIMIT 1', [dedupeKey]);
    return r ? this.rowToItem(r) : null;
  }

  static textDedupeKey(text: string): string {
    return `text:${stableHash(text.replace(/\s+/g, ' ').trim().toLowerCase())}`;
  }

  /** Create an item, or return the existing one when the dedupe key matches. */
  async createItem(input: NewItem): Promise<{ item: Item; duplicate: boolean }> {
    const now = this.now();
    const id = input.id ?? newId('it');
    const sync = await this.syncEnabled();
    // Duplicate check and insert happen in one transaction, so concurrent captures cannot both insert.
    const dupId = await this.db.transaction(async (tx) => {
      if (input.dedupeKey) {
        const dup = await tx.get<{ id: string }>('SELECT id FROM items WHERE dedupe_key = ? AND deleted = 0 ORDER BY captured_at LIMIT 1', [input.dedupeKey]);
        if (dup) return dup.id;
      }
      await tx.run(
        `INSERT INTO items (id, source_type, url, dedupe_key, title, note, author, summary, summary_origin, status, origin,
           captured_at, created_at, updated_at, sync_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, input.sourceType, input.url ?? null, input.dedupeKey ?? null, input.title ?? '', input.note ?? '', input.author ?? '',
          input.summary ?? '', input.summary ? 'user' : 'none', input.status ?? 'CAPTURED', input.origin ?? 'local',
          input.capturedAt ?? now, now, now, sync ? 'pending' : 'local_only',
        ],
      );
      for (const tag of input.tags ?? []) await this.addTag(id, tag, 'user', tx);
      await this.reindexMeta(id, tx);
      return null;
    });
    if (dupId) return { item: (await this.getItem(dupId)) as Item, duplicate: true };
    return { item: (await this.getItem(id)) as Item, duplicate: false };
  }

  async updateItem(id: string, patch: ItemPatch, opts: { userEdit?: boolean } = {}): Promise<Item | null> {
    const cols: string[] = [];
    const params: SqlValue[] = [];
    const set = (col: string, v: SqlValue) => {
      cols.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.note !== undefined) set('note', patch.note);
    if (patch.summary !== undefined) set('summary', patch.summary);
    if (patch.summaryOrigin !== undefined) set('summary_origin', patch.summaryOrigin);
    if (patch.author !== undefined) set('author', patch.author);
    if (patch.siteName !== undefined) set('site_name', patch.siteName);
    if (patch.thumbnailUrl !== undefined) set('thumbnail_url', patch.thumbnailUrl);
    if (patch.url !== undefined) set('url', patch.url);
    if (patch.language !== undefined) set('language', patch.language);
    if (patch.languageMethod !== undefined) set('language_method', patch.languageMethod);
    if (patch.enrichment !== undefined) set('enrichment_json', patch.enrichment ? JSON.stringify(patch.enrichment) : null);
    if (patch.metadata !== undefined) set('metadata_json', patch.metadata ? JSON.stringify(patch.metadata) : null);
    if (patch.archived !== undefined) set('archived', patch.archived ? 1 : 0);
    if (!cols.length && !opts.userEdit) return this.getItem(id);
    set('updated_at', this.now());
    const touchesSynced = Object.keys(patch).some((k) => SYNCED_FIELDS.has(k)) || opts.userEdit;
    if (touchesSynced) cols.push('local_rev = local_rev + 1', `sync_status = CASE WHEN sync_status = 'conflicted' THEN 'conflicted' WHEN server_revision IS NOT NULL OR ? = 1 THEN 'pending' ELSE 'local_only' END`);
    if (touchesSynced) params.push((await this.syncEnabled()) ? 1 : 0);
    params.push(id);
    await this.db.transaction(async (tx) => {
      await tx.run(`UPDATE items SET ${cols.join(', ')} WHERE id = ?`, params);
      await this.reindexMeta(id, tx);
    });
    return this.getItem(id);
  }

  async setStatus(id: string, to: ItemStatus, error?: { code: string; message: string } | null): Promise<Item | null> {
    const item = await this.getItem(id);
    if (!item) return null;
    const next = transition(item.status, to);
    await this.db.run('UPDATE items SET status = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?', [
      next, error?.code ?? null, error?.message ?? null, this.now(), id,
    ]);
    return this.getItem(id);
  }

  async markViewed(id: string): Promise<void> {
    await this.db.run('UPDATE items SET last_viewed_at = ? WHERE id = ?', [this.now(), id]);
  }

  // ── favourites, highlights, revisit reminders (this phone only: not synced) ──
  async setFavorite(ids: string[], favorite: boolean): Promise<void> {
    if (!ids.length) return;
    await this.db.run(`UPDATE items SET favorite = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [favorite ? 1 : 0, ...ids]);
  }

  async addHighlight(h: { itemId: string; text: string; startMs: number | null; source: Highlight['source'] }): Promise<Highlight> {
    const out: Highlight = { id: newId('hl'), itemId: h.itemId, text: h.text.trim(), startMs: h.startMs, source: h.source, createdAt: this.now() };
    await this.db.run('INSERT INTO highlights (id, item_id, text, start_ms, source, created_at) VALUES (?,?,?,?,?,?)',
      [out.id, out.itemId, out.text, out.startMs, out.source, out.createdAt]);
    return out;
  }

  /** Highlights of one item, or of the whole library (newest first, live items only); `text` filters by content. */
  async listHighlights(opts: { itemId?: string; text?: string; limit?: number } = {}): Promise<Highlight[]> {
    const where = ['i.deleted = 0'];
    const params: SqlValue[] = [];
    if (opts.itemId) { where.push('h.item_id = ?'); params.push(opts.itemId); }
    if (opts.text) { where.push(`LOWER(h.text) LIKE ? ESCAPE '\\'`); params.push(`%${opts.text.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`); }
    const rows = await this.db.all<Row>(
      `SELECT h.* FROM highlights h JOIN items i ON i.id = h.item_id WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC, h.rowid DESC LIMIT ?`,
      [...params, opts.limit ?? 500],
    );
    return rows.map((r) => ({ id: str(r.id), itemId: str(r.item_id), text: str(r.text), startMs: r.start_ms === null ? null : Number(r.start_ms), source: str(r.source) as Highlight['source'], createdAt: str(r.created_at) }));
  }

  async deleteHighlight(id: string): Promise<void> {
    await this.db.run('DELETE FROM highlights WHERE id = ?', [id]);
  }

  async setReminder(id: string, at: string | null, notificationId: string | null): Promise<void> {
    await this.db.run('UPDATE items SET remind_at = ?, remind_notification_id = ? WHERE id = ?', [at, notificationId, id]);
  }

  async reminderNotificationId(id: string): Promise<string | null> {
    return strOrNull((await this.db.get<Row>('SELECT remind_notification_id FROM items WHERE id = ?', [id]))?.remind_notification_id);
  }

  /** Items with a reminder still ahead, soonest first. */
  async upcomingReminders(nowIso: string, limit = 20): Promise<Item[]> {
    const rows = await this.db.all<Row>('SELECT * FROM items WHERE deleted = 0 AND remind_at IS NOT NULL AND remind_at > ? ORDER BY remind_at ASC LIMIT ?', [nowIso, limit]);
    return Promise.all(rows.map((r) => this.rowToItem(r)));
  }

  /** Counts for the Library shelves. */
  async shelfCounts(): Promise<{ favorites: number; unread: number; viewed: number; highlights: number }> {
    const r = await this.db.get<Row>(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE deleted = 0 AND archived = 0 AND favorite = 1) AS favorites,
         (SELECT COUNT(*) FROM items WHERE deleted = 0 AND archived = 0 AND last_viewed_at IS NULL) AS unread,
         (SELECT COUNT(*) FROM items WHERE deleted = 0 AND archived = 0 AND last_viewed_at IS NOT NULL) AS viewed,
         (SELECT COUNT(*) FROM highlights h JOIN items i ON i.id = h.item_id WHERE i.deleted = 0) AS highlights`,
    );
    return { favorites: Number(r?.favorites ?? 0), unread: Number(r?.unread ?? 0), viewed: Number(r?.viewed ?? 0), highlights: Number(r?.highlights ?? 0) };
  }

  async setArchived(ids: string[], archived: boolean): Promise<number> {
    let n = 0;
    for (const id of ids) if (await this.updateItem(id, { archived })) n++;
    return n;
  }

  /** Soft delete (synced as a tombstone). Items never synced are purged outright. */
  async deleteItems(ids: string[]): Promise<number> {
    const sync = await this.syncEnabled();
    let n = 0;
    await this.db.transaction(async (tx) => {
      for (const id of ids) {
        const r = await tx.get<Row>('SELECT server_revision FROM items WHERE id = ?', [id]);
        if (!r) continue;
        n++;
        if (r.server_revision === null && !sync) {
          await tx.run('DELETE FROM items WHERE id = ?', [id]);
        } else {
          await tx.run(
            `UPDATE items SET deleted = 1, local_rev = local_rev + 1, sync_status = 'pending', updated_at = ? WHERE id = ?`,
            [this.now(), id],
          );
          await tx.run('DELETE FROM chunks WHERE item_id = ?', [id]);
        }
      }
    });
    return n;
  }

  async listItems(filter: LibraryFilter, sort: SortKey = 'newest', limit = 30, offset = 0): Promise<Item[]> {
    const ids = await this.queryItemIds(filter, sort, limit, offset);
    const out: Item[] = [];
    for (const id of ids) {
      const it = await this.getItem(id);
      if (it) out.push(it);
    }
    return out;
  }

  async countItems(filter: LibraryFilter): Promise<number> {
    const { where, params, text } = await this.filterSql(filter);
    if (text) return (await this.queryItemIds(filter, 'newest', 10_000, 0)).length;
    const r = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM items i WHERE ${where}`, params);
    return Number(r?.n ?? 0);
  }

  /**
   * WHERE clause for a filter. A smart collection's rules stand in for its
   * membership table and are ANDed with the rest of the filter; rule text is
   * added to the full-text query.
   */
  private async filterSql(filter: LibraryFilter): Promise<{ where: string; params: (string | number)[]; text: string }> {
    let text = filter.text?.trim() ?? '';
    const rules = filter.collectionId ? await this.collectionRules(filter.collectionId) : null;
    if (!rules) return { ...buildFilterSql(filter), text };
    const rf = rulesToFilter(rules, this.clock());
    if (rf.text) text = [text, rf.text].filter(Boolean).join(' ');
    const base = buildFilterSql({ ...filter, collectionId: undefined });
    const extra = buildFilterSql({ ...rf, text: undefined, archived: filter.archived });
    return { where: `${base.where} AND ${extra.where}`, params: [...base.params, ...extra.params], text };
  }

  private async queryItemIds(filter: LibraryFilter, sort: SortKey, limit: number, offset: number): Promise<string[]> {
    const { where, params, text } = await this.filterSql(filter);
    if (!text) {
      const rows = await this.db.all<{ id: string }>(
        `SELECT i.id FROM items i WHERE ${where} ORDER BY ${orderBySql(sort)} LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );
      return rows.map((r) => r.id);
    }
    for (const q of [buildFtsQuery(text), buildFtsOrQuery(text)]) {
      if (!q) continue;
      // bm25() cannot be used inside an aggregate, so score matches first in a materialized CTE.
      const rows = await this.db.all<{ id: string }>(
        `WITH hits AS MATERIALIZED (SELECT rowid AS cid, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ?)
         SELECT i.id, MIN(h.score) AS rank FROM hits h
           JOIN chunks c ON c.id = h.cid
           JOIN items i ON i.id = c.item_id
         WHERE ${where}
         GROUP BY i.id ORDER BY ${sort === 'newest' ? 'rank ASC, i.captured_at DESC' : orderBySql(sort)} LIMIT ? OFFSET ?`,
        [q, ...params, limit, offset],
      );
      if (rows.length) return rows.map((r) => r.id);
    }
    return [];
  }

  // ── tags ─────────────────────────────────────────────────────────────────
  async addTag(itemId: string, tag: string, origin: 'user' | 'suggested' | 'model' = 'user', ex: SqlExecutor = this.db): Promise<void> {
    const t = tag.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 40);
    if (!t) return;
    await ex.run('INSERT OR IGNORE INTO item_tags (item_id, tag, origin) VALUES (?, ?, ?)', [itemId, t, origin]);
  }

  async setTags(itemId: string, tags: string[]): Promise<Item | null> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM item_tags WHERE item_id = ?', [itemId]);
      for (const t of tags) await this.addTag(itemId, t, 'user', tx);
    });
    // Bumps the revision (tags are synced) and rebuilds the search chunk.
    return this.updateItem(itemId, {}, { userEdit: true });
  }

  async allTags(): Promise<{ tag: string; count: number }[]> {
    return this.db.all(
      `SELECT t.tag AS tag, COUNT(*) AS count FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE i.deleted = 0 AND i.archived = 0 GROUP BY t.tag ORDER BY count DESC, tag ASC`,
    );
  }

  /** Languages present in the library (for the Library filter), excluding "unknown". */
  async itemLanguages(): Promise<string[]> {
    const rows = await this.db.all<{ language: string }>(`SELECT DISTINCT language FROM items WHERE deleted = 0 AND language != 'und'`);
    return rows.map((r) => r.language);
  }

  /** Items whose GitHub README was saved as plain text (before 1.9.3 kept Markdown). */
  async oldReadmeItemIds(): Promise<string[]> {
    const rows = await this.db.all<{ item_id: string }>(
      `SELECT DISTINCT t.item_id FROM transcripts t JOIN items i ON i.id = t.item_id
       WHERE t.source = 'github_readme' AND (t.format IS NULL OR t.format != 'md') AND i.deleted = 0`,
    );
    return rows.map((r) => r.item_id);
  }

  async transcriptCount(): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcripts'))?.n ?? 0);
  }

  async tagCountsInRange(startIso: string, endIso: string): Promise<{ tag: string; count: number }[]> {
    return this.db.all(
      `SELECT t.tag AS tag, COUNT(*) AS count FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE i.deleted = 0 AND i.captured_at >= ? AND i.captured_at < ? GROUP BY t.tag ORDER BY count DESC LIMIT 12`,
      [startIso, endIso],
    );
  }

  // ── collections ──────────────────────────────────────────────────────────
  async createCollection(name: string, icon = 'folder', id?: string): Promise<Collection> {
    const now = this.now();
    const cid = id ?? newId('col');
    const sync = await this.syncEnabled();
    await this.db.run(
      'INSERT INTO collections (id, name, icon, created_at, updated_at, sync_status) VALUES (?,?,?,?,?,?)',
      [cid, name.trim().slice(0, 120) || 'Untitled', icon, now, now, sync ? 'pending' : 'local_only'],
    );
    return (await this.getCollection(cid)) as Collection;
  }

  /** A collection defined by rules; its items are resolved live by listItems/countItems. */
  async createSmartCollection(name: string, rules: SmartRules, icon = 'sparkles'): Promise<Collection> {
    const clean = sanitizeRules(rules);
    if (!clean) throw new Error('A smart collection needs at least one rule.');
    const now = this.now();
    const cid = newId('col');
    const sync = await this.syncEnabled();
    await this.db.run(
      'INSERT INTO collections (id, name, icon, created_at, updated_at, sync_status, rules_json) VALUES (?,?,?,?,?,?,?)',
      [cid, name.trim().slice(0, 120) || 'Untitled', icon, now, now, sync ? 'pending' : 'local_only', JSON.stringify(clean)],
    );
    return (await this.getCollection(cid)) as Collection;
  }

  async updateSmartRules(id: string, rules: SmartRules): Promise<void> {
    const clean = sanitizeRules(rules);
    if (!clean) throw new Error('A smart collection needs at least one rule.');
    await this.db.run(
      `UPDATE collections SET rules_json = ?, updated_at = ?, local_rev = local_rev + 1,
         sync_status = CASE WHEN server_revision IS NOT NULL THEN 'pending' ELSE sync_status END WHERE id = ?`,
      [JSON.stringify(clean), this.now(), id],
    );
  }

  /** Rules of a live smart collection, or null for a manual (or missing) one. */
  async collectionRules(id: string): Promise<SmartRules | null> {
    const r = await this.db.get<{ rules_json: string | null }>('SELECT rules_json FROM collections WHERE id = ? AND deleted = 0', [id]);
    return r?.rules_json ? sanitizeRules(r.rules_json) : null;
  }

  private async withCount(r: Row): Promise<Collection> {
    const col = collectionFromRow(r);
    if (col.rules) col.itemCount = await this.countItems({ collectionId: col.id });
    return col;
  }

  async getCollection(id: string): Promise<Collection | null> {
    const r = await this.db.get<Row>(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_items ci JOIN items i ON i.id = ci.item_id
          WHERE ci.collection_id = c.id AND i.deleted = 0) AS n FROM collections c WHERE c.id = ? AND c.deleted = 0`,
      [id],
    );
    return r ? this.withCount(r) : null;
  }

  async listCollections(): Promise<Collection[]> {
    const rows = await this.db.all<Row>(
      `SELECT c.*, (SELECT COUNT(*) FROM collection_items ci JOIN items i ON i.id = ci.item_id
          WHERE ci.collection_id = c.id AND i.deleted = 0) AS n
       FROM collections c WHERE c.deleted = 0 ORDER BY c.created_at ASC`,
    );
    const out: Collection[] = [];
    for (const r of rows) out.push(await this.withCount(r));
    return out;
  }

  /** Most common enrichment concepts across live items (lowercased). */
  async topConcepts(limit = 12): Promise<{ concept: string; count: number }[]> {
    return this.db.all(
      `SELECT LOWER(jc.value) AS concept, COUNT(DISTINCT i.id) AS count
       FROM items i, json_each(CASE WHEN json_valid(i.enrichment_json) THEN i.enrichment_json ELSE '{}' END, '$.concepts') jc
       WHERE i.deleted = 0 AND i.archived = 0 AND jc.type = 'text' AND TRIM(jc.value) != ''
       GROUP BY LOWER(jc.value) ORDER BY count DESC, concept ASC LIMIT ?`,
      [limit],
    );
  }

  /**
   * Smart collections worth creating: the concepts and tags shared by at least
   * `minItems` live items that are not already a collection name.
   */
  async suggestCollections(limit = 5, minItems = 3): Promise<CollectionSuggestion[]> {
    const concepts = await this.db.all<{ name: string; n: number }>(
      `SELECT LOWER(jc.value) AS name, COUNT(DISTINCT i.id) AS n
       FROM items i, json_each(CASE WHEN json_valid(i.enrichment_json) THEN i.enrichment_json ELSE '{}' END, '$.concepts') jc
       WHERE i.deleted = 0 AND i.archived = 0 AND jc.type = 'text' AND TRIM(jc.value) != ''
       GROUP BY LOWER(jc.value) HAVING n >= ?`,
      [minItems],
    );
    const tags = await this.db.all<{ name: string; n: number }>(
      `SELECT t.tag AS name, COUNT(DISTINCT i.id) AS n FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE i.deleted = 0 AND i.archived = 0 GROUP BY t.tag HAVING n >= ?`,
      [minItems],
    );
    const taken = new Set((await this.db.all<{ name: string }>('SELECT name FROM collections WHERE deleted = 0')).map((r) => r.name.trim().toLowerCase()));
    const best = new Map<string, CollectionSuggestion>();
    const add = (name: string, count: number, kind: 'concept' | 'tag') => {
      const key = name.trim().toLowerCase();
      if (!key || taken.has(key) || taken.has(`#${key}`)) return;
      const prev = best.get(key);
      if (prev && prev.count >= count) return;
      best.set(key, { name: key, kind, count, rules: kind === 'concept' ? { concepts: [key] } : { tags: [key] } });
    };
    for (const c of concepts) add(c.name, Number(c.n), 'concept');
    for (const t of tags) add(t.name, Number(t.n), 'tag');
    return [...best.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
  }

  async renameCollection(id: string, name: string): Promise<void> {
    await this.db.run(
      `UPDATE collections SET name = ?, updated_at = ?, local_rev = local_rev + 1,
         sync_status = CASE WHEN server_revision IS NOT NULL THEN 'pending' ELSE sync_status END WHERE id = ?`,
      [name.trim().slice(0, 120), this.now(), id],
    );
  }

  async deleteCollection(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM collection_items WHERE collection_id = ?', [id]);
      await tx.run(
        `UPDATE collections SET deleted = 1, updated_at = ?, local_rev = local_rev + 1,
           sync_status = CASE WHEN server_revision IS NOT NULL THEN 'pending' ELSE sync_status END WHERE id = ?`,
        [this.now(), id],
      );
    });
  }

  async addToCollection(collectionId: string, itemIds: string[]): Promise<void> {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      for (const id of itemIds) {
        await tx.run('INSERT OR IGNORE INTO collection_items (collection_id, item_id, added_at) VALUES (?,?,?)', [collectionId, id, now]);
      }
    });
    for (const id of itemIds) await this.updateItem(id, {}, { userEdit: true });
  }

  async removeFromCollection(collectionId: string, itemIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const id of itemIds) await tx.run('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?', [collectionId, id]);
    });
    for (const id of itemIds) await this.updateItem(id, {}, { userEdit: true });
  }

  async itemCollectionIds(itemId: string): Promise<string[]> {
    const rows = await this.db.all<{ collection_id: string }>('SELECT collection_id FROM collection_items WHERE item_id = ?', [itemId]);
    return rows.map((r) => r.collection_id);
  }

  // ── flashcards (local only) ──────────────────────────────────────────────
  /** Insert new cards for an item, skipping any whose question it already has. Returns the cards added. */
  async addCards(itemId: string, cards: { front: string; back: string; startMs: number | null; origin: Card['origin'] }[]): Promise<Card[]> {
    const now = this.now();
    const ids: string[] = [];
    await this.db.transaction(async (tx) => {
      const existing = new Set((await tx.all<{ front: string }>('SELECT front FROM cards WHERE item_id = ?', [itemId])).map((r) => normFront(r.front)));
      for (const c of cards) {
        const key = normFront(c.front);
        if (!key || existing.has(key)) continue;
        existing.add(key);
        const id = newId('card');
        await tx.run(
          'INSERT INTO cards (id, item_id, front, back, start_ms, due_at, interval_days, ease, reps, lapses, created_at, origin) VALUES (?,?,?,?,?,?,0,2.5,0,0,?,?)',
          [id, itemId, c.front, c.back, c.startMs, now, now, c.origin],
        );
        ids.push(id);
      }
    });
    const out: Card[] = [];
    for (const id of ids) out.push((await this.getCard(id)) as Card);
    return out;
  }

  async getCard(id: string): Promise<Card | null> {
    const r = await this.db.get<Row>('SELECT * FROM cards WHERE id = ?', [id]);
    return r ? cardFromRow(r) : null;
  }

  async listCards(itemId: string): Promise<Card[]> {
    const rows = await this.db.all<Row>('SELECT * FROM cards WHERE item_id = ? ORDER BY created_at, rowid', [itemId]);
    return rows.map(cardFromRow);
  }

  async saveCardSchedule(card: Pick<Card, 'id' | 'dueAt' | 'intervalDays' | 'ease' | 'reps' | 'lapses'>): Promise<void> {
    await this.db.run('UPDATE cards SET due_at = ?, interval_days = ?, ease = ?, reps = ?, lapses = ? WHERE id = ?', [
      card.dueAt, card.intervalDays, card.ease, card.reps, card.lapses, card.id,
    ]);
  }

  /** Cards due at `nowIso` on live items, optionally limited to a collection (manual or smart). */
  private async dueScope(nowIso: string, collectionId?: string): Promise<{ where: string; params: SqlValue[] }> {
    if (!collectionId) return { where: 'c.due_at <= ? AND i.deleted = 0', params: [nowIso] };
    const f = await this.filterSql({ collectionId });
    let where = `c.due_at <= ? AND ${f.where}`;
    const params: SqlValue[] = [nowIso, ...f.params];
    if (f.text) {
      const ids = await this.queryItemIds({ collectionId }, 'newest', 10_000, 0);
      if (!ids.length) return { where: '0', params: [] };
      where += ` AND i.id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    return { where, params };
  }

  async dueCards(nowIso: string, limit = 20, collectionId?: string): Promise<Card[]> {
    const { where, params } = await this.dueScope(nowIso, collectionId);
    const rows = await this.db.all<Row>(
      `SELECT c.* FROM cards c JOIN items i ON i.id = c.item_id WHERE ${where} ORDER BY c.due_at ASC, c.created_at ASC, c.rowid ASC LIMIT ?`,
      [...params, limit],
    );
    return rows.map(cardFromRow);
  }

  /** All cards, and those "learned" (next review three weeks or more away). */
  async cardStats(): Promise<{ total: number; learned: number }> {
    const r = await this.db.get<{ total: number; learned: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN c.interval_days >= 21 THEN 1 ELSE 0 END), 0) AS learned
       FROM cards c JOIN items i ON i.id = c.item_id WHERE i.deleted = 0`,
    );
    return { total: Number(r?.total ?? 0), learned: Number(r?.learned ?? 0) };
  }

  async countDueCards(nowIso: string, collectionId?: string): Promise<number> {
    const { where, params } = await this.dueScope(nowIso, collectionId);
    const r = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.id = c.item_id WHERE ${where}`, params);
    return Number(r?.n ?? 0);
  }

  // ── transcripts & index ─────────────────────────────────────────────────
  /** Idempotent on (item, language, kind, source): retries replace, never duplicate. */
  async upsertTranscript(input: TranscriptInput): Promise<Transcript> {
    const now = this.now();
    const kind = input.kind ?? 'original';
    const id = `tr_${stableHash(`${input.itemId}|${input.language}|${kind}|${input.source}`)}`;
    const text = segmentsToText(input.segments);
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO transcripts (id, item_id, language, language_method, kind, source, provider, format, text, segment_count,
            has_timestamps, origin, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(item_id, language, kind, source) DO UPDATE SET text = excluded.text, provider = excluded.provider,
            format = excluded.format, segment_count = excluded.segment_count, has_timestamps = excluded.has_timestamps,
            language_method = excluded.language_method, corrected = 0, updated_at = excluded.updated_at`,
        [
          id, input.itemId, input.language, input.languageMethod ?? 'heuristic', kind, input.source, input.provider ?? null,
          input.format ?? null, text, input.segments.length, hasTimestamps(input.segments) ? 1 : 0, input.origin ?? 'local', now, now,
        ],
      );
      await this.writeSegments(id, input.segments, tx);
      await this.reindexTranscript(id, tx);
    });
    return (await this.getTranscript(id)) as Transcript;
  }

  private async writeSegments(transcriptId: string, segments: Segment[], tx: SqlExecutor): Promise<void> {
    await tx.run('DELETE FROM transcript_segments WHERE transcript_id = ?', [transcriptId]);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      await tx.run('INSERT INTO transcript_segments (transcript_id, ordinal, start_ms, end_ms, text) VALUES (?,?,?,?,?)', [
        transcriptId, i, s.startMs, s.endMs, s.text,
      ]);
    }
  }

  async getTranscript(id: string): Promise<Transcript | null> {
    const r = await this.db.get<Row>('SELECT * FROM transcripts WHERE id = ?', [id]);
    return r ? transcriptFromRow(r) : null;
  }

  async listTranscripts(itemId: string): Promise<Transcript[]> {
    const rows = await this.db.all<Row>(
      `SELECT * FROM transcripts WHERE item_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, language`,
      [itemId],
    );
    return rows.map(transcriptFromRow);
  }

  async getSegments(transcriptId: string): Promise<Segment[]> {
    const rows = await this.db.all<Row>('SELECT start_ms, end_ms, text FROM transcript_segments WHERE transcript_id = ? ORDER BY ordinal', [transcriptId]);
    return rows.map((r) => ({ startMs: r.start_ms === null ? null : Number(r.start_ms), endMs: r.end_ms === null ? null : Number(r.end_ms), text: str(r.text) }));
  }

  /** User correction: replaces segment text but keeps timestamps; the original source label is preserved. */
  async correctTranscript(id: string, segments: Segment[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('UPDATE transcripts SET text = ?, segment_count = ?, corrected = 1, updated_at = ? WHERE id = ?', [
        segmentsToText(segments), segments.length, this.now(), id,
      ]);
      await this.writeSegments(id, segments, tx);
      await this.reindexTranscript(id, tx);
    });
  }

  async setTranscriptLanguage(id: string, language: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run(`UPDATE transcripts SET language = ?, language_method = 'user', updated_at = ? WHERE id = ?`, [language, this.now(), id]);
      await tx.run('UPDATE chunks SET language = ? WHERE transcript_id = ?', [language, id]);
    });
  }

  async deleteTranscript(id: string): Promise<void> {
    await this.db.run('DELETE FROM transcripts WHERE id = ?', [id]);
  }

  private async reindexTranscript(transcriptId: string, tx: SqlExecutor): Promise<void> {
    const t = await tx.get<Row>('SELECT item_id, language FROM transcripts WHERE id = ?', [transcriptId]);
    if (!t) return;
    await tx.run('DELETE FROM chunks WHERE transcript_id = ?', [transcriptId]);
    const segRows = await tx.all<Row>('SELECT start_ms, end_ms, text FROM transcript_segments WHERE transcript_id = ? ORDER BY ordinal', [transcriptId]);
    const segs: Segment[] = segRows.map((r) => ({ startMs: r.start_ms === null ? null : Number(r.start_ms), endMs: r.end_ms === null ? null : Number(r.end_ms), text: str(r.text) }));
    for (const c of chunkSegments(segs)) {
      await tx.run('INSERT INTO chunks (item_id, transcript_id, kind, ordinal, text, start_ms, end_ms, language) VALUES (?,?,?,?,?,?,?,?)', [
        str(t.item_id), transcriptId, 'transcript', c.ordinal, c.text, c.startMs, c.endMs, str(t.language),
      ]);
    }
  }

  /** Metadata chunk: title, URL, tags, note and summary — the item-level searchable text. */
  async reindexMeta(itemId: string, tx: SqlExecutor = this.db): Promise<void> {
    const r = await tx.get<Row>('SELECT * FROM items WHERE id = ?', [itemId]);
    await tx.run(`DELETE FROM chunks WHERE item_id = ? AND kind IN ('meta','note','summary')`, [itemId]);
    if (!r || Number(r.deleted) === 1) return;
    const tags = await tx.all<{ tag: string }>('SELECT tag FROM item_tags WHERE item_id = ?', [itemId]);
    const enr = parseJson<Enrichment | null>(r.enrichment_json, null);
    const meta = [str(r.title), str(r.url), str(r.author), str(r.site_name), tags.map((t) => t.tag).join(' '),
      enr ? [...enr.tools, ...enr.repos, ...enr.concepts].join(' ') : ''].filter(Boolean).join('\n');
    const lang = str(r.language);
    if (meta) await tx.run('INSERT INTO chunks (item_id, kind, ordinal, text, language) VALUES (?,?,?,?,?)', [itemId, 'meta', 0, meta, lang]);
    if (str(r.note)) await tx.run('INSERT INTO chunks (item_id, kind, ordinal, text, language) VALUES (?,?,?,?,?)', [itemId, 'note', 0, str(r.note), lang]);
    const summary = [str(r.summary), ...(enr?.keyPoints ?? [])].filter(Boolean).join('\n');
    if (summary) await tx.run('INSERT INTO chunks (item_id, kind, ordinal, text, language) VALUES (?,?,?,?,?)', [itemId, 'summary', 0, summary, lang]);
  }

  async searchChunks(text: string, opts: { itemIds?: string[]; limit?: number; filter?: LibraryFilter } = {}): Promise<ChunkHit[]> {
    const limit = opts.limit ?? 30;
    const resolved = await this.filterSql(opts.filter ?? {});
    const { where, params } = resolved;
    let itemIds = opts.itemIds;
    // A text rule (smart collection) cannot share the chunk MATCH, so scope to the items it selects.
    if (resolved.text) {
      const allowed = new Set(await this.queryItemIds(opts.filter ?? {}, 'newest', 10_000, 0));
      itemIds = (itemIds?.length ? itemIds : [...allowed]).filter((id) => allowed.has(id));
      if (!itemIds.length) return [];
    }
    for (const q of [buildFtsQuery(text), buildFtsOrQuery(text)]) {
      if (!q) continue;
      const scope = itemIds?.length ? `AND c.item_id IN (${itemIds.map(() => '?').join(',')})` : '';
      const rows = await this.db.all<Row>(
        `WITH hits AS MATERIALIZED (SELECT rowid AS cid, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ?)
         SELECT c.id, c.item_id, c.transcript_id, c.kind, c.text, c.start_ms, c.end_ms, c.language, h.score AS rank
         FROM hits h JOIN chunks c ON c.id = h.cid JOIN items i ON i.id = c.item_id
         WHERE ${where} ${scope} ORDER BY rank LIMIT ?`,
        [q, ...params, ...(itemIds ?? []), limit],
      );
      if (rows.length) return rows.map(chunkFromRow);
    }
    return [];
  }

  async chunksForItems(itemIds: string[], perItem = 3): Promise<ChunkHit[]> {
    const out: ChunkHit[] = [];
    for (const id of itemIds) {
      const rows = await this.db.all<Row>(
        `SELECT id, item_id, transcript_id, kind, text, start_ms, end_ms, language, 0 AS rank FROM chunks WHERE item_id = ?
         ORDER BY CASE kind WHEN 'summary' THEN 0 WHEN 'note' THEN 1 WHEN 'meta' THEN 2 ELSE 3 END, ordinal LIMIT ?`,
        [id, perItem],
      );
      out.push(...rows.map(chunkFromRow));
    }
    return out;
  }

  async getChunk(id: number): Promise<ChunkHit | null> {
    const r = await this.db.get<Row>('SELECT *, 0 AS rank FROM chunks WHERE id = ?', [id]);
    return r ? chunkFromRow(r) : null;
  }

  // ── embeddings (optional semantic search) ───────────────────────────────
  async chunksMissingEmbeddings(model: string, limit = 32): Promise<{ id: number; text: string }[]> {
    return this.db.all(
      `SELECT c.id, c.text FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ?
       WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT ?`,
      [model, limit],
    );
  }

  async saveEmbeddings(model: string, rows: { chunkId: number; vector: number[] }[]): Promise<void> {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.run('INSERT OR REPLACE INTO embeddings (chunk_id, model, vector, created_at) VALUES (?,?,?,?)', [
          r.chunkId, model, JSON.stringify(r.vector.map((x) => Number(x.toFixed(5)))), now,
        ]);
      }
    });
  }

  async allEmbeddings(model: string): Promise<{ chunkId: number; itemId: string; vector: number[] }[]> {
    const rows = await this.db.all<Row>(
      `SELECT e.chunk_id, c.item_id, e.vector FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
       JOIN items i ON i.id = c.item_id WHERE e.model = ? AND i.deleted = 0`,
      [model],
    );
    return rows.map((r) => ({ chunkId: Number(r.chunk_id), itemId: str(r.item_id), vector: parseJson<number[]>(r.vector, []) }));
  }

  // ── media ────────────────────────────────────────────────────────────────
  async addMedia(itemId: string, file: { uri: string; name: string; mime: string; size: number }): Promise<string> {
    const id = newId('med');
    await this.db.run('INSERT INTO media (id, item_id, uri, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', [
      id, itemId, file.uri, file.name, file.mime, file.size, this.now(),
    ]);
    return id;
  }

  async listMedia(itemId: string): Promise<{ id: string; uri: string; name: string; mime: string; size: number; uploadedAt: string | null }[]> {
    const rows = await this.db.all<Row>('SELECT * FROM media WHERE item_id = ? ORDER BY created_at DESC', [itemId]);
    return rows.map((r) => ({ id: str(r.id), uri: str(r.uri), name: str(r.name), mime: str(r.mime), size: Number(r.size), uploadedAt: strOrNull(r.uploaded_at) }));
  }

  async markMediaUploaded(id: string): Promise<void> {
    await this.db.run('UPDATE media SET uploaded_at = ? WHERE id = ?', [this.now(), id]);
  }

  // ── jobs (persistent queue) ─────────────────────────────────────────────
  /**
   * Enqueue idempotently. An existing queued/running/succeeded job with the same
   * id is left alone; a failed or cancelled one is re-queued only if `retry`.
   */
  async enqueueJob(input: { id?: string; kind: JobKind; itemId?: string | null; payload?: Record<string, unknown>; runAfter?: string; maxAttempts?: number; retry?: boolean }): Promise<{ job: Job; created: boolean }> {
    const id = input.id ?? `job_${input.kind}_${input.itemId ?? 'global'}`;
    const existing = await this.getJob(id);
    const now = this.now();
    if (existing) {
      const terminalFailure = ['failed_permanent', 'failed_retryable', 'cancelled'].includes(existing.status);
      const rerun = (input.retry && (terminalFailure || existing.status === 'succeeded')) || (existing.status === 'succeeded' && input.retry === undefined && input.kind === 'sync');
      if (!rerun) return { job: existing, created: false };
      await this.db.run(
        `UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, last_error_code = NULL,
           payload_json = COALESCE(?, payload_json), updated_at = ? WHERE id = ?`,
        [input.runAfter ?? now, input.payload ? JSON.stringify(input.payload) : null, now, id],
      );
      return { job: (await this.getJob(id)) as Job, created: true };
    }
    await this.db.run(
      `INSERT INTO jobs (id, item_id, kind, status, max_attempts, run_after, payload_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, input.itemId ?? null, input.kind, 'queued', input.maxAttempts ?? 5, input.runAfter ?? now, input.payload ? JSON.stringify(input.payload) : null, now, now],
    );
    return { job: (await this.getJob(id)) as Job, created: true };
  }

  async getJob(id: string): Promise<Job | null> {
    const r = await this.db.get<Row>('SELECT * FROM jobs WHERE id = ?', [id]);
    return r ? jobFromRow(r) : null;
  }

  async listJobs(opts: { itemId?: string; statuses?: JobStatus[]; limit?: number } = {}): Promise<Job[]> {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (opts.itemId) {
      clauses.push('item_id = ?');
      params.push(opts.itemId);
    }
    if (opts.statuses?.length) {
      clauses.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    const rows = await this.db.all<Row>(
      `SELECT * FROM jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`,
      [...params, opts.limit ?? 100],
    );
    return rows.map(jobFromRow);
  }

  /** Atomically claim due jobs so two runners (foreground + background task) never run the same job. */
  async claimDueJobs(limit = 5): Promise<Job[]> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const rows = await tx.all<Row>(
        `SELECT * FROM jobs WHERE status IN ('queued','failed_retryable') AND run_after <= ? ORDER BY run_after LIMIT ?`,
        [now, limit],
      );
      for (const r of rows) {
        await tx.run(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`, [now, str(r.id)]);
      }
      return rows.map((r) => ({ ...jobFromRow(r), status: 'running' as JobStatus, attempts: Number(r.attempts) + 1 }));
    });
  }

  async completeJob(id: string, result?: Record<string, unknown>): Promise<void> {
    await this.db.run(`UPDATE jobs SET status = 'succeeded', result_json = ?, last_error = NULL, last_error_code = NULL, updated_at = ? WHERE id = ? AND status = 'running'`, [
      result ? JSON.stringify(result) : null, this.now(), id,
    ]);
  }

  async failJob(id: string, err: { code: string; message: string; retryable: boolean }, rand: () => number = Math.random): Promise<Job | null> {
    const job = await this.getJob(id);
    if (!job || job.status === 'cancelled') return job;
    const exhausted = job.attempts >= job.maxAttempts;
    const status: JobStatus = err.retryable && !exhausted ? 'failed_retryable' : 'failed_permanent';
    const runAfter = new Date(this.clock().getTime() + backoffMs(job.attempts, 15_000, 6 * 3600_000, rand)).toISOString();
    await this.db.run('UPDATE jobs SET status = ?, last_error_code = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?', [
      status, err.code, err.message.slice(0, 500), runAfter, this.now(), id,
    ]);
    return this.getJob(id);
  }

  async cancelJob(id: string): Promise<boolean> {
    const r = await this.db.run(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running','failed_retryable')`, [this.now(), id]);
    return r.changes > 0;
  }

  async setServerJobId(id: string, serverJobId: string): Promise<void> {
    await this.db.run('UPDATE jobs SET server_job_id = ?, updated_at = ? WHERE id = ?', [serverJobId, this.now(), id]);
  }

  /** After process death, jobs left 'running' are re-queued. */
  async recoverRunningJobs(): Promise<number> {
    const r = await this.db.run(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'`, [this.now()]);
    return r.changes;
  }

  async jobCounts(): Promise<Record<JobStatus, number>> {
    const rows = await this.db.all<{ status: JobStatus; n: number }>('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
    const out = { queued: 0, running: 0, succeeded: 0, failed_retryable: 0, failed_permanent: 0, cancelled: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  // ── reports ──────────────────────────────────────────────────────────────
  async saveReport(r: Omit<Report, 'exportedUri' | 'exportedAt'>): Promise<Report> {
    await this.db.run(
      `INSERT OR REPLACE INTO reports (id, title, kind, range_start, range_end, timezone, params_json, markdown, provider, item_ids, filename, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.title, r.kind, r.rangeStart, r.rangeEnd, r.timezone, JSON.stringify(r.params), r.markdown, r.provider, JSON.stringify(r.itemIds), r.filename, r.createdAt],
    );
    return (await this.getReport(r.id)) as Report;
  }

  async getReport(id: string): Promise<Report | null> {
    const r = await this.db.get<Row>('SELECT * FROM reports WHERE id = ?', [id]);
    return r ? reportFromRow(r) : null;
  }

  async listReports(limit = 100): Promise<Report[]> {
    return (await this.db.all<Row>('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?', [limit])).map(reportFromRow);
  }

  async deleteReport(id: string): Promise<void> {
    await this.db.run('DELETE FROM reports WHERE id = ?', [id]);
  }

  async markReportExported(id: string, uri: string): Promise<void> {
    await this.db.run('UPDATE reports SET exported_uri = ?, exported_at = ? WHERE id = ?', [uri, this.now(), id]);
  }

  // ── conversations ────────────────────────────────────────────────────────
  async createConversation(title: string): Promise<string> {
    const id = newId('conv');
    const now = this.now();
    await this.db.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?,?,?,?)', [id, title.slice(0, 120), now, now]);
    return id;
  }

  async listConversations(): Promise<{ id: string; title: string; updatedAt: string }[]> {
    const rows = await this.db.all<Row>('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50');
    return rows.map((r) => ({ id: str(r.id), title: str(r.title), updatedAt: str(r.updated_at) }));
  }

  async deleteConversation(id: string): Promise<void> {
    await this.db.run('DELETE FROM conversations WHERE id = ?', [id]);
  }

  async addMessage(m: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const id = newId('msg');
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO messages (id, conversation_id, role, content, mode, provider, warnings_json, proposals_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, m.conversationId, m.role, m.content, m.mode, m.provider, JSON.stringify(m.warnings), JSON.stringify(m.proposals), now],
      );
      for (const c of m.citations) {
        await tx.run('INSERT OR REPLACE INTO message_citations (message_id, sid, item_id, transcript_id, chunk_id, start_ms, quote) VALUES (?,?,?,?,?,?,?)', [
          id, c.sid, c.itemId, c.transcriptId, c.chunkId, c.startMs, c.quote.slice(0, 600),
        ]);
      }
      await tx.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, m.conversationId]);
    });
    return { ...m, id, createdAt: now };
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    const rows = await this.db.all<Row>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', [conversationId]);
    const out: Message[] = [];
    for (const r of rows) {
      const cites = await this.db.all<Row>('SELECT * FROM message_citations WHERE message_id = ? ORDER BY sid', [str(r.id)]);
      out.push({
        id: str(r.id), conversationId, role: str(r.role) as Message['role'], content: str(r.content), mode: strOrNull(r.mode),
        provider: strOrNull(r.provider), warnings: parseJson(r.warnings_json, []), proposals: parseJson(r.proposals_json, []),
        createdAt: str(r.created_at),
        citations: cites.map((c): Citation => ({
          sid: str(c.sid), itemId: str(c.item_id), transcriptId: strOrNull(c.transcript_id), chunkId: c.chunk_id === null ? null : Number(c.chunk_id),
          startMs: c.start_ms === null ? null : Number(c.start_ms), quote: str(c.quote),
        })),
      });
    }
    return out;
  }

  // ── conflicts ────────────────────────────────────────────────────────────
  async addConflict(kind: Conflict['entityKind'], entityId: string, remote: Record<string, unknown>, remoteRevision: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run(`UPDATE conflicts SET resolved_at = ?, resolution = 'superseded' WHERE entity_id = ? AND resolved_at IS NULL`, [this.now(), entityId]);
      await tx.run('INSERT INTO conflicts (id, entity_kind, entity_id, remote_json, remote_revision, detected_at) VALUES (?,?,?,?,?,?)', [
        newId('cf'), kind, entityId, JSON.stringify(remote), remoteRevision, this.now(),
      ]);
      await tx.run(`UPDATE ${kind === 'item' ? 'items' : 'collections'} SET sync_status = 'conflicted' WHERE id = ?`, [entityId]);
    });
  }

  async openConflicts(): Promise<Conflict[]> {
    const rows = await this.db.all<Row>('SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY detected_at');
    return rows.map((r) => ({
      id: str(r.id), entityKind: str(r.entity_kind) as Conflict['entityKind'], entityId: str(r.entity_id),
      remote: parseJson(r.remote_json, {}), remoteRevision: Number(r.remote_revision), detectedAt: str(r.detected_at),
    }));
  }

  async resolveConflictRecord(id: string, resolution: string): Promise<void> {
    await this.db.run('UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ?', [this.now(), resolution, id]);
  }

  // ── usage (cost visibility) ─────────────────────────────────────────────
  async addUsage(e: { provider: string; model: string | null; kind: string; promptTokens?: number | null; completionTokens?: number | null }): Promise<void> {
    await this.db.run('INSERT INTO usage_events (provider, model, kind, prompt_tokens, completion_tokens, created_at) VALUES (?,?,?,?,?,?)', [
      e.provider, e.model, e.kind, e.promptTokens ?? null, e.completionTokens ?? null, this.now(),
    ]);
  }

  async usageSince(iso: string): Promise<{ calls: number; promptTokens: number; completionTokens: number }> {
    const r = await this.db.get<Row>(
      'SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c FROM usage_events WHERE created_at >= ?',
      [iso],
    );
    return { calls: Number(r?.calls ?? 0), promptTokens: Number(r?.p ?? 0), completionTokens: Number(r?.c ?? 0) };
  }

  // ── dashboard queries ────────────────────────────────────────────────────
  async countByStatusInRange(startIso: string, endIso: string): Promise<Record<string, number>> {
    const rows = await this.db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM items WHERE deleted = 0 AND captured_at >= ? AND captured_at < ? GROUP BY status',
      [startIso, endIso],
    );
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  async countWhere(sql: string, params: SqlValue[] = []): Promise<number> {
    const r = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM items WHERE deleted = 0 AND ${sql}`, params);
    return Number(r?.n ?? 0);
  }

  /** Home feed: what is ready to look at, what needs the user, what is in progress, and one item to resurface. */
  async homeFeed(dayKey: string, limit = 10): Promise<{ ready: Item[]; needsYou: Item[]; processing: Item[]; resurface: Item | null }> {
    const q = (where: string, order: string, params: SqlValue[] = []) =>
      this.db.all<Row>(`SELECT * FROM items WHERE deleted = 0 AND archived = 0 AND ${where} ORDER BY ${order} LIMIT ?`, [...params, limit]).then((rows) => Promise.all(rows.map((r) => this.rowToItem(r))));
    const ready = await q(`status = 'READY' AND last_viewed_at IS NULL`, 'updated_at DESC');
    const needsYou = await q(`status IN ('NEEDS_INPUT','FAILED_RETRYABLE','FAILED_PERMANENT')`, 'updated_at DESC');
    const processing = await q(`status IN ('CAPTURED','METADATA_CHECK','TRANSCRIBING','ENRICHING','INDEXING')`, 'captured_at DESC');
    // Something saved (and last seen) at least 3 days ago; the pick changes once a day.
    const cutoff = new Date(this.clock().getTime() - 3 * 86400_000).toISOString();
    const old = `status = 'READY' AND captured_at < ? AND (last_viewed_at IS NULL OR last_viewed_at < ?)`;
    const n = await this.countWhere(`archived = 0 AND ${old}`, [cutoff, cutoff]);
    let resurface: Item | null = null;
    if (n) {
      let h = 0;
      for (const ch of dayKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const row = await this.db.get<Row>(`SELECT * FROM items WHERE deleted = 0 AND archived = 0 AND ${old} ORDER BY captured_at ASC LIMIT 1 OFFSET ?`, [cutoff, cutoff, h % n]);
      resurface = row ? await this.rowToItem(row) : null;
    }
    return { ready, needsYou, processing, resurface };
  }

  async recentlyViewed(limit = 5): Promise<Item[]> {
    const rows = await this.db.all<Row>('SELECT * FROM items WHERE deleted = 0 AND last_viewed_at IS NOT NULL ORDER BY last_viewed_at DESC LIMIT ?', [limit]);
    return Promise.all(rows.map((r) => this.rowToItem(r)));
  }

  async itemsInRange(startIso: string, endIso: string, limit = 500): Promise<Item[]> {
    const rows = await this.db.all<Row>(
      'SELECT * FROM items WHERE deleted = 0 AND captured_at >= ? AND captured_at < ? ORDER BY captured_at ASC LIMIT ?',
      [startIso, endIso, limit],
    );
    return Promise.all(rows.map((r) => this.rowToItem(r)));
  }

  async itemsByIds(ids: string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const id of ids) {
      const it = await this.getItem(id);
      if (it && !it.deleted) out.push(it);
    }
    return out;
  }

  async relatedItems(item: Item, limit = 5): Promise<Item[]> {
    if (!item.tags.length) return [];
    const rows = await this.db.all<{ item_id: string; n: number }>(
      `SELECT t.item_id, COUNT(*) AS n FROM item_tags t JOIN items i ON i.id = t.item_id
       WHERE t.tag IN (${item.tags.map(() => '?').join(',')}) AND t.item_id != ? AND i.deleted = 0
       GROUP BY t.item_id ORDER BY n DESC LIMIT ?`,
      [...item.tags, item.id, limit],
    );
    return this.itemsByIds(rows.map((r) => r.item_id));
  }

  // ── export / delete-all ─────────────────────────────────────────────────
  async exportAll(): Promise<Record<string, unknown>> {
    const tables = ['items', 'item_tags', 'collections', 'collection_items', 'transcripts', 'transcript_segments', 'reports', 'conversations', 'messages', 'message_citations', 'media', 'cards'];
    const out: Record<string, unknown> = { format: 'qivra-export', version: 1, exportedAt: this.now() };
    for (const t of tables) out[t] = await this.db.all(`SELECT * FROM ${t}`);
    return out;
  }

  async deleteEverything(): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const t of ['cards', 'message_citations', 'messages', 'conversations', 'reports', 'conflicts', 'embeddings', 'chunks', 'transcript_segments', 'transcripts', 'media', 'collection_items', 'collections', 'item_tags', 'jobs', 'usage_events', 'items']) {
        await tx.run(`DELETE FROM ${t}`);
      }
      await tx.run(`DELETE FROM meta WHERE key NOT LIKE 'app.%'`);
    });
  }
}

function collectionFromRow(r: Row): Collection {
  return {
    id: str(r.id), name: str(r.name), icon: str(r.icon), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    itemCount: Number(r.n ?? 0), syncStatus: str(r.sync_status) as SyncStatus, rules: r.rules_json ? sanitizeRules(r.rules_json) : null,
  };
}

const normFront = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function cardFromRow(r: Row): Card {
  return {
    id: str(r.id), itemId: str(r.item_id), front: str(r.front), back: str(r.back),
    startMs: r.start_ms === null || r.start_ms === undefined ? null : Number(r.start_ms), dueAt: str(r.due_at),
    intervalDays: Number(r.interval_days), ease: Number(r.ease), reps: Number(r.reps), lapses: Number(r.lapses),
    createdAt: str(r.created_at), origin: str(r.origin) === 'model' ? 'model' : 'local',
  };
}

function transcriptFromRow(r: Row): Transcript {
  return {
    id: str(r.id), itemId: str(r.item_id), language: str(r.language), languageMethod: str(r.language_method) as Transcript['languageMethod'],
    kind: str(r.kind) as Transcript['kind'], source: str(r.source), provider: strOrNull(r.provider), format: strOrNull(r.format),
    text: str(r.text), segmentCount: Number(r.segment_count), hasTimestamps: Number(r.has_timestamps) === 1,
    origin: str(r.origin) as Transcript['origin'], corrected: Number(r.corrected) === 1, createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

function chunkFromRow(r: Row): ChunkHit {
  return {
    chunkId: Number(r.id), itemId: str(r.item_id), transcriptId: strOrNull(r.transcript_id), kind: str(r.kind), text: str(r.text),
    startMs: r.start_ms === null || r.start_ms === undefined ? null : Number(r.start_ms),
    endMs: r.end_ms === null || r.end_ms === undefined ? null : Number(r.end_ms), language: strOrNull(r.language), rank: Number(r.rank ?? 0),
  };
}

function jobFromRow(r: Row): Job {
  return {
    id: str(r.id), itemId: strOrNull(r.item_id), kind: str(r.kind) as JobKind, status: str(r.status) as JobStatus,
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), runAfter: str(r.run_after), lastErrorCode: strOrNull(r.last_error_code),
    lastError: strOrNull(r.last_error), payload: parseJson(r.payload_json, null), result: parseJson(r.result_json, null),
    serverJobId: strOrNull(r.server_job_id), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

function reportFromRow(r: Row): Report {
  return {
    id: str(r.id), title: str(r.title), kind: str(r.kind), rangeStart: str(r.range_start), rangeEnd: str(r.range_end), timezone: str(r.timezone),
    params: parseJson(r.params_json, {}), markdown: str(r.markdown), provider: strOrNull(r.provider), itemIds: parseJson(r.item_ids, []),
    filename: str(r.filename), exportedUri: strOrNull(r.exported_uri), exportedAt: strOrNull(r.exported_at), createdAt: str(r.created_at),
  };
}
