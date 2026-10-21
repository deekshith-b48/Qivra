import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeDriver } from '../helpers/nodeDriver';
import { LATEST_VERSION, migrate } from '../../src/db/schema';
import { Repo } from '../../src/db/repo';
import { importLegacy } from '../../src/db/legacy';
import { parseTranscript } from '../../src/core/transcripts';
import { analyzeUrl } from '../../src/core/url';

async function freshRepo(path = ':memory:', clock?: () => Date) {
  const db = openNodeDriver(path);
  await migrate(db);
  return new Repo(db, clock);
}

const yt = analyzeUrl('https://youtu.be/dQw4w9WgXcQ')!;

describe('migrations', () => {
  test('fresh database migrates to latest and is idempotent', async () => {
    const db = openNodeDriver();
    expect(await migrate(db)).toEqual({ from: 0, to: LATEST_VERSION });
    expect(await migrate(db)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION });
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['items', 'transcripts', 'chunks', 'chunks_fts', 'jobs', 'reports', 'conflicts', 'messages']));
  });

  test('refuses a database from a newer app version (no silent data loss)', async () => {
    const db = openNodeDriver();
    await db.exec('PRAGMA user_version = 999');
    await expect(migrate(db)).rejects.toThrow(/newer/);
  });

  test('existing data survives re-running migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qivra-'));
    const repo = await freshRepo(join(dir, 'q.db'));
    await repo.createItem({ sourceType: 'note', title: 'Keep me' });
    await repo.db.close();
    const again = await freshRepo(join(dir, 'q.db'));
    expect((await again.listItems({})).map((i) => i.title)).toEqual(['Keep me']);
  });
});

describe('items, duplicates, tags, collections', () => {
  test('duplicate detection returns the existing item', async () => {
    const repo = await freshRepo();
    const a = await repo.createItem({ sourceType: 'youtube', url: yt.url, dedupeKey: yt.dedupeKey, title: 'First' });
    const b = await repo.createItem({ sourceType: 'youtube', url: yt.url, dedupeKey: yt.dedupeKey, title: 'Again' });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ item: a.item, duplicate: true });
    expect(await repo.countItems({})).toBe(1);
  });

  test('edits bump revisions; local-only until sync is enabled', async () => {
    const repo = await freshRepo();
    const { item } = await repo.createItem({ sourceType: 'note', title: 'n' });
    expect(item).toMatchObject({ localRev: 1, syncStatus: 'local_only', status: 'CAPTURED' });
    const edited = await repo.updateItem(item.id, { note: 'hello' });
    expect(edited).toMatchObject({ localRev: 2, syncStatus: 'local_only' });
    await repo.setMeta('sync.enabled', '1');
    expect((await repo.setTags(item.id, ['AI', '#Claude Code']))?.tags).toEqual(['ai', 'claude-code']);
    expect((await repo.getItem(item.id))?.syncStatus).toBe('pending');
    // Status changes are processing state, not user edits.
    const before = (await repo.getItem(item.id))!.localRev;
    await repo.setStatus(item.id, 'INDEXING');
    expect((await repo.getItem(item.id))!.localRev).toBe(before);
    await expect(repo.setStatus(item.id, 'CAPTURED')).rejects.toThrow(/Invalid status transition/);
  });

  test('archive, restore, delete', async () => {
    const repo = await freshRepo();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await repo.createItem({ sourceType: 'note', title: `n${i}` })).item.id);
    await repo.setArchived([ids[0]], true);
    expect(await repo.countItems({})).toBe(2);
    expect(await repo.countItems({ archived: true })).toBe(1);
    await repo.setArchived([ids[0]], false);
    expect(await repo.deleteItems([ids[1]])).toBe(1);
    expect(await repo.getItem(ids[1])).toBeNull(); // never synced → purged
    await repo.setMeta('sync.enabled', '1');
    await repo.deleteItems([ids[2]]);
    expect(await repo.getItem(ids[2])).toMatchObject({ deleted: true, syncStatus: 'pending' }); // tombstone for sync
    expect(await repo.countItems({})).toBe(1);
  });

  test('collections and filters', async () => {
    const repo = await freshRepo(':memory:', () => new Date('2026-10-21T10:00:00Z'));
    const a = (await repo.createItem({ sourceType: 'github', title: 'repo A', capturedAt: '2026-10-20T10:00:00Z' })).item;
    const b = (await repo.createItem({ sourceType: 'youtube', title: 'video B', capturedAt: '2026-10-21T09:00:00Z', tags: ['agents'] })).item;
    const col = await repo.createCollection('Read later');
    await repo.addToCollection(col.id, [a.id, b.id]);
    expect((await repo.listCollections())[0]).toMatchObject({ name: 'Read later', itemCount: 2 });
    expect((await repo.listItems({ collectionId: col.id, sourceTypes: ['github'] })).map((i) => i.id)).toEqual([a.id]);
    expect((await repo.listItems({ tags: ['agents'] })).map((i) => i.id)).toEqual([b.id]);
    expect((await repo.listItems({ fromIso: '2026-10-21T00:00:00Z' })).map((i) => i.id)).toEqual([b.id]);
    expect((await repo.listItems({}, 'oldest')).map((i) => i.id)).toEqual([a.id, b.id]);
    expect((await repo.listItems({}, 'newest', 1, 1)).map((i) => i.id)).toEqual([a.id]); // pagination
    await repo.removeFromCollection(col.id, [a.id]);
    expect((await repo.getCollection(col.id))?.itemCount).toBe(1);
  });
});

describe('transcripts and full-text search', () => {
  const srt = `1\n00:00:01,000 --> 00:00:05,000\nToday we configure Claude Code hooks.\n\n2\n00:01:10,000 --> 00:01:15,000\nThe hook runs npm test before every commit.\n`;

  test('import is idempotent and searchable with timestamps', async () => {
    const repo = await freshRepo();
    const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Hooks tutorial' });
    const { segments } = parseTranscript(srt);
    const t1 = await repo.upsertTranscript({ itemId: item.id, language: 'en', source: 'import_srt', segments, format: 'srt' });
    const t2 = await repo.upsertTranscript({ itemId: item.id, language: 'en', source: 'import_srt', segments, format: 'srt' });
    expect(t1.id).toBe(t2.id);
    expect(await repo.listTranscripts(item.id)).toHaveLength(1);
    expect(t1).toMatchObject({ segmentCount: 2, hasTimestamps: true });
    const hits = await repo.searchChunks('npm test');
    expect(hits[0]).toMatchObject({ itemId: item.id, kind: 'transcript', startMs: 1000 });
    expect((await repo.listItems({ text: 'claude hooks' })).map((i) => i.id)).toEqual([item.id]);
  });

  test('translations are stored separately from the original', async () => {
    const repo = await freshRepo();
    const { item } = await repo.createItem({ sourceType: 'youtube', title: 'v' });
    await repo.upsertTranscript({ itemId: item.id, language: 'es', source: 'import_vtt', segments: [{ startMs: 0, endMs: 1, text: 'Hola agentes' }] });
    await repo.upsertTranscript({ itemId: item.id, language: 'en', kind: 'translation', source: 'user_translation', segments: [{ startMs: 0, endMs: 1, text: 'Hello agents' }] });
    const list = await repo.listTranscripts(item.id);
    expect(list.map((t) => [t.kind, t.language])).toEqual([['original', 'es'], ['translation', 'en']]);
    expect(list[0].text).toBe('Hola agentes');
  });

  test('corrections keep timestamps and reindex; language override is recorded', async () => {
    const repo = await freshRepo();
    const { item } = await repo.createItem({ sourceType: 'youtube', title: 'v' });
    const t = await repo.upsertTranscript({ itemId: item.id, language: 'und', source: 'paste', segments: [{ startMs: 5000, endMs: 6000, text: 'clod code is great' }] });
    await repo.correctTranscript(t.id, [{ startMs: 5000, endMs: 6000, text: 'Claude Code is great' }]);
    await repo.setTranscriptLanguage(t.id, 'en');
    expect(await repo.getTranscript(t.id)).toMatchObject({ corrected: true, language: 'en', languageMethod: 'user' });
    expect(await repo.searchChunks('clod')).toEqual([]);
    expect((await repo.searchChunks('claude'))[0].startMs).toBe(5000);
  });

  test('search is accent-insensitive, safe with operators, and excludes deleted/archived items', async () => {
    const repo = await freshRepo();
    const a = (await repo.createItem({ sourceType: 'note', title: 'Café résumé tips' })).item;
    expect((await repo.listItems({ text: 'cafe resume' })).map((i) => i.id)).toEqual([a.id]);
    expect(await repo.listItems({ text: '" OR 1=1 --' })).toEqual([]);
    await repo.setArchived([a.id], true);
    expect(await repo.listItems({ text: 'cafe' })).toEqual([]);
  });

  test('library search stays fast on a sizeable dataset', async () => {
    const repo = await freshRepo();
    await repo.db.transaction(async (tx) => {
      for (let i = 0; i < 2000; i++) {
        await tx.run(`INSERT INTO items (id, source_type, title, captured_at, created_at, updated_at) VALUES (?, 'note', ?, ?, ?, ?)`, [
          `bulk${i}`, `Bulk note ${i} about ${i % 10 === 0 ? 'kubernetes' : 'cooking'}`, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z',
        ]);
        await repo.reindexMeta(`bulk${i}`, tx);
      }
    });
    const t0 = Date.now();
    const res = await repo.listItems({ text: 'kubernetes' }, 'newest', 30);
    expect(res).toHaveLength(30);
    expect(await repo.countItems({ text: 'kubernetes' })).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('persistent job queue', () => {
  test('idempotent enqueue, claim, backoff, permanent failure, cancel', async () => {
    let now = new Date('2026-10-21T10:00:00Z');
    const repo = await freshRepo(':memory:', () => now);
    const a = await repo.enqueueJob({ kind: 'local_enrich', itemId: 'x', maxAttempts: 2 });
    const b = await repo.enqueueJob({ kind: 'local_enrich', itemId: 'x' });
    expect(b).toEqual({ job: a.job, created: false });
    const [claimed] = await repo.claimDueJobs();
    expect(claimed).toMatchObject({ id: a.job.id, status: 'running', attempts: 1 });
    expect(await repo.claimDueJobs()).toEqual([]); // not claimable twice
    const f1 = await repo.failJob(claimed.id, { code: 'NET', message: 'offline', retryable: true }, () => 0);
    expect(f1).toMatchObject({ status: 'failed_retryable', lastErrorCode: 'NET' });
    expect(await repo.claimDueJobs()).toEqual([]); // backoff not elapsed
    now = new Date('2026-10-21T11:00:00Z');
    const [again] = await repo.claimDueJobs();
    const f2 = await repo.failJob(again.id, { code: 'NET', message: 'offline', retryable: true });
    expect(f2?.status).toBe('failed_permanent'); // attempts exhausted
    const retried = await repo.enqueueJob({ kind: 'local_enrich', itemId: 'x', retry: true });
    expect(retried.job.status).toBe('queued');
    expect(await repo.cancelJob(retried.job.id)).toBe(true);
    expect(await repo.claimDueJobs()).toEqual([]);
  });

  test('jobs survive process death and running jobs are recovered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qivra-jobs-'));
    const repo = await freshRepo(join(dir, 'q.db'));
    await repo.enqueueJob({ kind: 'index', itemId: 'a' });
    await repo.enqueueJob({ kind: 'index', itemId: 'b' });
    await repo.claimDueJobs(1); // 'a' running when the process dies
    await repo.db.close();
    const after = await freshRepo(join(dir, 'q.db'));
    expect(await after.recoverRunningJobs()).toBe(1);
    expect((await after.claimDueJobs(5)).map((j) => j.itemId).sort()).toEqual(['a', 'b']);
  });
});

describe('legacy SuperBrain import', () => {
  test('imports posts and collections once, preserving provenance', async () => {
    const repo = await freshRepo();
    const data = {
      posts: [
        { shortcode: 'YT_dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Old video', summary: 'AI summary', tags: '["ai"]', category: 'education', analyzed_at: '2026-09-01T10:00:00' },
        { shortcode: 'DRWKk5JiL0h', url: 'https://www.instagram.com/p/DRWKk5JiL0h/', title: 'Reel', tags: ['food'] },
        { shortcode: '', title: 'broken' },
      ],
      collections: [{ id: 'default_watch_later', name: 'Watch Later', icon: 'time', postIds: ['DRWKk5JiL0h', 'missing'] }],
    };
    expect(await importLegacy(repo, data)).toEqual({ posts: 2, skipped: 1, collections: 1 });
    expect(await importLegacy(repo, data)).toEqual({ posts: 0, skipped: 0, collections: 0 });
    const v = await repo.getItem('sb_YT_dQw4w9WgXcQ');
    expect(v).toMatchObject({ sourceType: 'youtube', summary: 'AI summary', summaryOrigin: 'server', origin: 'superbrain', capturedAt: '2026-09-01T10:00:00.000Z', syncStatus: 'local_only' });
    expect(v?.tags).toEqual(['ai', 'education']);
    expect((await repo.listItems({ collectionId: 'default_watch_later' })).map((i) => i.id)).toEqual(['sb_DRWKk5JiL0h']);
  });
});

describe('export and delete', () => {
  test('export contains user data; delete-everything empties it', async () => {
    const repo = await freshRepo();
    const { item } = await repo.createItem({ sourceType: 'note', title: 'secret note', note: 'n' });
    await repo.upsertTranscript({ itemId: item.id, language: 'en', source: 'paste', segments: [{ startMs: null, endMs: null, text: 'body' }] });
    await repo.setMeta('app.onboarded', '1');
    const dump = await repo.exportAll();
    expect(dump.format).toBe('qivra-export');
    expect((dump.items as unknown[]).length).toBe(1);
    expect((dump.transcripts as unknown[]).length).toBe(1);
    await repo.deleteEverything();
    expect(await repo.countItems({})).toBe(0);
    expect(await repo.searchChunks('body')).toEqual([]);
    expect(await repo.getMeta('app.onboarded')).toBe('1');
  });
});

describe('concurrency', () => {
  test('concurrent captures of the same link create exactly one item', async () => {
    const repo = await freshRepo();
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.createItem({ sourceType: 'youtube', url: yt.url, dedupeKey: yt.dedupeKey })));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
    expect(await repo.countItems({})).toBe(1);
  });
});
