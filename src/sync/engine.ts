/**
 * Local-server synchronisation (metadata, notes, tags, collections).
 *
 * Contract (see docs/LOCAL_SERVER_AND_QR_PAIRING.md → Sync):
 *  - Every local edit bumps `local_rev`; `synced_local_rev` records what the
 *    server has acknowledged. `server_revision` is the server's version we
 *    last based an edit on.
 *  - Pushes carry `base_revision`. The server applies a change only if its
 *    copy is still at that revision; otherwise it returns its copy as a
 *    conflict and changes nothing.
 *  - Incoming changes overwrite a local item only if it has no unsynced
 *    edits. Otherwise a conflict is recorded for the user to resolve.
 *  - Transcripts and media are NOT synced automatically (privacy); they are
 *    sent only when the user asks for server processing.
 */

import type { QivraClient, ServerEntity, SyncChange } from '../core/api';
import { newId } from '../core/ids';
import { sanitizeRules } from '../core/smart';
import type { Repo } from '../db/repo';
import type { Item } from '../db/types';

type Row = Record<string, unknown>;

export interface SyncStats {
  pushed: number;
  applied: number;
  conflicts: number;
  pulled: number;
  purged: number;
}

export async function itemToServerData(repo: Repo, item: Item): Promise<Record<string, unknown>> {
  return {
    sourceType: item.sourceType,
    url: item.url && /^https?:\/\//.test(item.url) ? item.url : null,
    title: item.title,
    note: item.note,
    summary: item.summaryOrigin === 'none' ? '' : item.summary,
    keyPoints: item.enrichment?.keyPoints ?? [],
    tags: item.tags,
    collectionIds: await repo.itemCollectionIds(item.id),
    language: item.language,
    status: item.status,
    createdAt: item.createdAt,
    capturedAt: item.capturedAt,
    archived: item.archived,
    author: item.author,
    thumbnailUrl: item.thumbnailUrl,
    entities: item.enrichment
      ? { tools: item.enrichment.tools, repos: item.enrichment.repos, commands: item.enrichment.commands.map((c) => c.command) }
      : { tools: [], repos: [], commands: [] },
  };
}

export async function runSync(repo: Repo, client: QivraClient, opts: { maxRounds?: number } = {}): Promise<SyncStats> {
  const stats: SyncStats = { pushed: 0, applied: 0, conflicts: 0, pulled: 0, purged: 0 };
  let cursor = Number((await repo.getMeta('sync.cursor')) ?? 0);
  for (let round = 0; round < (opts.maxRounds ?? 20); round++) {
    const { changes, sentRevs } = await collectOutgoing(repo);
    stats.pushed += changes.length;
    const resp = await client.sync(cursor, changes);
    const justApplied = new Map<string, number | null>();
    for (const a of resp.applied) {
      justApplied.set(`${a.kind}:${a.id}`, a.revision);
      await markAcknowledged(repo, a.kind as 'item' | 'collection', a.id, a.revision, sentRevs.get(`${a.kind}:${a.id}`) ?? 0);
      stats.applied++;
    }
    for (const c of resp.conflicts) {
      if (!c.server) continue;
      const sent = changes.find((x) => x.kind === c.kind && x.id === c.id);
      if (sent && !c.server.deleted && c.server.updated_by === 'server') {
        // The newer server revision came from server-side processing, not another device: rebase and push again.
        await repo.db.run(`UPDATE ${c.kind === 'item' ? 'items' : 'collections'} SET server_revision = ? WHERE id = ?`, [c.server.revision, c.id]);
        continue;
      }
      if (sent && !c.server.deleted && sameContent(sent.data, c.server.data)) {
        // Both sides already hold the same content (e.g. a migrated SuperBrain item): adopt the server revision.
        await markAcknowledged(repo, c.kind, c.id, c.server.revision, sentRevs.get(`${c.kind}:${c.id}`) ?? 0);
        continue;
      }
      await repo.addConflict(c.kind, c.id, c.server.data, c.server.revision);
      stats.conflicts++;
    }
    // Collections first, so item → collection memberships can be attached.
    const ordered = [...resp.changes].sort((a, b) => (a.kind === b.kind ? a.seq - b.seq : a.kind === 'collection' ? -1 : 1));
    const conflicted = new Set(resp.conflicts.map((c) => `${c.kind}:${c.id}`));
    for (const ent of ordered) {
      if (justApplied.has(`${ent.kind}:${ent.id}`) && justApplied.get(`${ent.kind}:${ent.id}`) === ent.revision) continue;
      if (conflicted.has(`${ent.kind}:${ent.id}`)) continue; // already handled from the push response
      const r = await applyRemote(repo, ent);
      if (r === 'pulled') stats.pulled++;
      else if (r === 'conflict') stats.conflicts++;
      else if (r === 'purged') stats.purged++;
    }
    cursor = resp.cursor;
    await repo.setMeta('sync.cursor', String(cursor));
    await repo.setMeta('sync.lastSuccessAt', new Date().toISOString());
    if (!resp.has_more && changes.length < 200) break;
  }
  return stats;
}

async function collectOutgoing(repo: Repo): Promise<{ changes: SyncChange[]; sentRevs: Map<string, number> }> {
  const sentRevs = new Map<string, number>();
  const changes: SyncChange[] = [];
  const cols = await repo.db.all<Row>(`SELECT * FROM collections WHERE sync_status IN ('pending','failed') LIMIT 100`);
  for (const c of cols) {
    changes.push({
      kind: 'collection', id: String(c.id), base_revision: c.server_revision === null ? null : Number(c.server_revision), deleted: Number(c.deleted) === 1,
      // `rules` is sent only for smart collections, so manual ones keep the original payload.
      data: { name: c.name, icon: c.icon, createdAt: c.created_at, updatedAt: c.updated_at, ...(c.rules_json ? { rules: sanitizeRules(c.rules_json) } : {}) },
    });
    sentRevs.set(`collection:${c.id}`, Number(c.local_rev));
  }
  const rows = await repo.db.all<Row>(`SELECT id FROM items WHERE sync_status IN ('pending','failed') ORDER BY updated_at LIMIT 200`);
  for (const r of rows) {
    const item = await repo.getItem(String(r.id));
    if (!item) continue;
    changes.push({ kind: 'item', id: item.id, base_revision: item.serverRevision, deleted: item.deleted, data: await itemToServerData(repo, item) });
    sentRevs.set(`item:${item.id}`, item.localRev);
  }
  return { changes, sentRevs };
}

async function markAcknowledged(repo: Repo, kind: 'item' | 'collection', id: string, revision: number | null, sentRev: number): Promise<void> {
  const table = kind === 'item' ? 'items' : 'collections';
  const row = await repo.db.get<Row>(`SELECT deleted, local_rev FROM ${table} WHERE id = ?`, [id]);
  if (!row) return;
  if (Number(row.deleted) === 1 && Number(row.local_rev) === sentRev) {
    await repo.db.run(`DELETE FROM ${table} WHERE id = ?`, [id]); // tombstone acknowledged
    return;
  }
  await repo.db.run(
    `UPDATE ${table} SET server_revision = ?, synced_local_rev = ?,
       sync_status = CASE WHEN local_rev = ? THEN 'synced' ELSE 'pending' END WHERE id = ?`,
    [revision, sentRev, sentRev, id],
  );
}

/** Apply one change from the server feed. */
export async function applyRemote(repo: Repo, ent: ServerEntity): Promise<'pulled' | 'skipped' | 'conflict' | 'purged'> {
  const table = ent.kind === 'item' ? 'items' : 'collections';
  const local = await repo.db.get<Row>(`SELECT * FROM ${table} WHERE id = ?`, [ent.id]);
  if (local) {
    const serverRev = local.server_revision === null ? null : Number(local.server_revision);
    if (serverRev !== null && ent.revision <= serverRev) return 'skipped';
    const dirty = Number(local.local_rev) > Number(local.synced_local_rev) || ['pending', 'conflicted'].includes(String(local.sync_status));
    if (dirty) {
      if (ent.updated_by === 'server' && !ent.deleted) {
        // Server processing results never compete with your edits: rebase; the next push keeps your changes.
        await repo.db.run(`UPDATE ${table} SET server_revision = ? WHERE id = ?`, [ent.revision, ent.id]);
        return 'skipped';
      }
      await repo.addConflict(ent.kind, ent.id, ent.data, ent.revision);
      return 'conflict';
    }
  }
  if (ent.deleted) {
    if (local) {
      await repo.db.run(`DELETE FROM ${table} WHERE id = ?`, [ent.id]);
      return 'purged';
    }
    return 'skipped';
  }
  if (ent.kind === 'collection') {
    const d = ent.data as { name?: string; icon?: string; createdAt?: string; updatedAt?: string; rules?: unknown };
    const rules = sanitizeRules(d.rules ?? null);
    await repo.db.run(
      `INSERT INTO collections (id, name, icon, created_at, updated_at, local_rev, synced_local_rev, server_revision, sync_status, rules_json)
       VALUES (?,?,?,?,?,1,1,?, 'synced', ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, updated_at = excluded.updated_at, rules_json = excluded.rules_json,
         server_revision = excluded.server_revision, synced_local_rev = collections.local_rev, sync_status = 'synced', deleted = 0`,
      [ent.id, String(d.name ?? 'Untitled'), String(d.icon ?? 'folder'), d.createdAt ?? ent.created_at, d.updatedAt ?? ent.updated_at, ent.revision, rules ? JSON.stringify(rules) : null],
    );
    return 'pulled';
  }
  await writeRemoteItem(repo, ent);
  return 'pulled';
}

async function writeRemoteItem(repo: Repo, ent: ServerEntity): Promise<void> {
  const d = ent.data as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const enrichment = d.enrichment as Record<string, unknown> | undefined;
  const now = new Date().toISOString();
  await repo.db.transaction(async (tx) => {
    const existing = await tx.get<Row>('SELECT summary_origin, enrichment_json FROM items WHERE id = ?', [ent.id]);
    const keepUserSummary = existing && String(existing.summary_origin) === 'user';
    let summary = s('summary');
    let summaryOrigin = summary ? 'server' : 'none';
    let enrichmentJson: string | null = existing ? (existing.enrichment_json as string | null) : null;
    if (enrichment && typeof enrichment === 'object') {
      enrichmentJson = JSON.stringify({
        origin: 'server', version: Number(enrichment.version ?? 1), provider: String(enrichment.provider ?? 'server'), generatedAt: String(enrichment.generatedAt ?? now),
        summary: String(enrichment.summary ?? ''), keyPoints: arr(enrichment.keyPoints), concepts: arr(enrichment.concepts), tools: arr(enrichment.tools),
        commands: arr(enrichment.commands).map((c) => ({ command: c, destructive: false })), repos: arr(enrichment.repos), urls: [],
        tags: arr(enrichment.tags), followUpQuestions: arr(enrichment.followUpQuestions), actionItems: arr(enrichment.actionItems), timestamps: [],
      });
      if (!summary && enrichment.summary) {
        summary = String(enrichment.summary);
        summaryOrigin = 'model';
      }
    }
    await tx.run(
      `INSERT INTO items (id, source_type, url, title, note, author, thumbnail_url, summary, summary_origin, language, status, origin,
          captured_at, created_at, updated_at, archived, enrichment_json, local_rev, synced_local_rev, server_revision, sync_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'server',?,?,?,?,?,1,1,?,'synced')
       ON CONFLICT(id) DO UPDATE SET source_type = excluded.source_type, url = excluded.url, title = excluded.title, note = excluded.note,
          author = excluded.author, thumbnail_url = excluded.thumbnail_url,
          summary = CASE WHEN ? THEN items.summary ELSE excluded.summary END,
          summary_origin = CASE WHEN ? THEN items.summary_origin ELSE excluded.summary_origin END,
          language = excluded.language, archived = excluded.archived, enrichment_json = excluded.enrichment_json,
          updated_at = excluded.updated_at, server_revision = excluded.server_revision, synced_local_rev = items.local_rev,
          sync_status = 'synced', deleted = 0`,
      [
        ent.id, s('sourceType') || 'web', s('url') || null, s('title'), s('note'), s('author'), s('thumbnailUrl'), summary, summaryOrigin,
        s('language') || 'und', validStatus(s('status')), s('capturedAt') || ent.created_at, s('createdAt') || ent.created_at, now,
        d.archived ? 1 : 0, enrichmentJson, ent.revision, keepUserSummary ? 1 : 0, keepUserSummary ? 1 : 0,
      ],
    );
    await tx.run('DELETE FROM item_tags WHERE item_id = ?', [ent.id]);
    for (const t of arr(d.tags)) await tx.run(`INSERT OR IGNORE INTO item_tags (item_id, tag, origin) VALUES (?, ?, 'user')`, [ent.id, t.toLowerCase().slice(0, 40)]);
    await tx.run('DELETE FROM collection_items WHERE item_id = ?', [ent.id]);
    for (const c of arr(d.collectionIds)) {
      await tx.run(
        'INSERT OR IGNORE INTO collection_items (collection_id, item_id, added_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM collections WHERE id = ?)',
        [c, ent.id, now, c],
      );
    }
    await repo.reindexMeta(ent.id, tx);
  });
}

/** Content equality on the user-visible fields (ignores timestamps and derived data). */
export function sameContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const pick = (d: Record<string, unknown>) =>
    JSON.stringify([d.title ?? '', d.url ?? null, d.note ?? '', d.name ?? '', [...arr(d.tags)].sort(), !!d.archived]);
  return pick(a) === pick(b);
}

/** Turn on sync: everything local becomes pending so it is pushed on the next run. */
export async function enableSync(repo: Repo): Promise<void> {
  await repo.setMeta('sync.enabled', '1');
  await repo.db.run(`UPDATE items SET sync_status = 'pending' WHERE sync_status = 'local_only'`);
  await repo.db.run(`UPDATE collections SET sync_status = 'pending' WHERE sync_status = 'local_only'`);
}

export async function disableSync(repo: Repo): Promise<void> {
  await repo.setMeta('sync.enabled', '0');
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function validStatus(s: string): string {
  return ['CAPTURED', 'NEEDS_INPUT', 'READY', 'FAILED_PERMANENT'].includes(s) ? s : s ? 'READY' : 'CAPTURED';
}

export type Resolution = 'keep_local' | 'keep_remote' | 'keep_both';

/** Resolve a recorded conflict. Nothing is lost: keep_both duplicates the local version. */
export async function resolveConflict(repo: Repo, conflictId: string, choice: Resolution): Promise<void> {
  const c = (await repo.openConflicts()).find((x) => x.id === conflictId);
  if (!c) throw new Error('Conflict not found or already resolved');
  const table = c.entityKind === 'item' ? 'items' : 'collections';
  if (choice === 'keep_local') {
    // Rebase the local edit on the server's revision; the next sync applies it deliberately.
    await repo.db.run(`UPDATE ${table} SET server_revision = ?, sync_status = 'pending' WHERE id = ?`, [c.remoteRevision, c.entityId]);
  } else {
    if (choice === 'keep_both' && c.entityKind === 'item') {
      const local = await repo.getItem(c.entityId);
      if (local) {
        const copy = await repo.createItem({
          id: newId('it'), sourceType: local.sourceType, url: local.url, dedupeKey: null, title: `${local.title || 'Untitled'} (my version)`,
          note: local.note, author: local.author, summary: local.summaryOrigin === 'user' ? local.summary : '', capturedAt: local.capturedAt, tags: local.tags, status: 'CAPTURED',
        });
        for (const col of await repo.itemCollectionIds(local.id)) await repo.addToCollection(col, [copy.item.id]);
      }
    }
    await repo.db.run(`UPDATE ${table} SET local_rev = synced_local_rev, sync_status = 'synced', server_revision = NULL WHERE id = ?`, [c.entityId]);
    await applyRemote(repo, {
      kind: c.entityKind, id: c.entityId, revision: c.remoteRevision, seq: 0, deleted: false, data: c.remote,
      created_at: String((c.remote as { createdAt?: string }).createdAt ?? new Date().toISOString()), updated_at: new Date().toISOString(), updated_by: null,
    });
  }
  await repo.resolveConflictRecord(conflictId, choice);
}

