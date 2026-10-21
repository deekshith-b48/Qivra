import { openNodeDriver } from '../helpers/nodeDriver';
import { migrate } from '../../src/db/schema';
import { Repo } from '../../src/db/repo';
import { selectReportItems, toReportSources } from '../../src/core/reportData';
import { buildReport } from '../../src/core/reports';

async function freshRepo() {
  const db = openNodeDriver();
  await migrate(db);
  return new Repo(db, () => new Date('2026-10-22T10:00:00Z'));
}

const NOW = Date.parse('2026-10-22T10:00:00Z');

describe('collection report', () => {
  test('covers exactly the collection items, newest first, regardless of date', async () => {
    const repo = await freshRepo();
    const old = (await repo.createItem({ sourceType: 'github', title: 'Old repo', capturedAt: '2025-01-05T10:00:00Z', tags: ['agents'] })).item;
    const recent = (await repo.createItem({ sourceType: 'youtube', title: 'Recent video', capturedAt: '2026-10-21T09:00:00Z', tags: ['agents'] })).item;
    await repo.createItem({ sourceType: 'note', title: 'Not in collection', capturedAt: '2026-10-21T09:30:00Z' });
    const col = await repo.createCollection('Agents <reading>');
    await repo.addToCollection(col.id, [old.id, recent.id]);

    const sel = await selectReportItems(repo, { kind: 'collection', collectionId: col.id }, NOW, 'UTC');
    expect(sel.items.map((i) => i.title)).toEqual(['Recent video', 'Old repo']);
    expect(sel.collection).toEqual({ id: col.id, name: 'Agents <reading>' });
    expect(sel.range).toMatchObject({ firstDay: '2025-01-05', lastDay: '2026-10-21' });

    const built = buildReport({ kind: 'collection', range: sel.range, generatedAt: '2026-10-22T10:00:00Z', collection: sel.collection, sources: await toReportSources(repo, sel.items) });
    expect(built.title).toBe('Collection: Agents <reading>');
    expect(built.filename).toBe('Qivra-Collection-Report-agents-reading-2026-10-21.md');
    expect(built.markdown).toContain('- **Collection:** Agents <reading>');
    expect(built.markdown).toContain('- **Items covered:** 2');
    expect(built.markdown).toContain('### S1. Recent video');
    expect(built.markdown).toContain('### S2. Old repo');
    expect(built.markdown).not.toContain('Not in collection');
    expect(built.markdown).toContain('**agents** — 2 item(s): S1, S2');
  });

  test('empty collection gives an empty report for today; a deleted one is an error', async () => {
    const repo = await freshRepo();
    const col = await repo.createCollection('Empty');
    const sel = await selectReportItems(repo, { kind: 'collection', collectionId: col.id }, NOW, 'UTC');
    expect(sel.items).toEqual([]);
    expect(sel.range).toMatchObject({ firstDay: '2026-10-22', lastDay: '2026-10-22' });
    await expect(selectReportItems(repo, { kind: 'collection', collectionId: 'col_missing' }, NOW, 'UTC')).rejects.toThrow(/no longer exists/);
    await expect(selectReportItems(repo, { kind: 'collection' }, NOW, 'UTC')).rejects.toThrow(/no longer exists/);
  });

  test('weekly report with a custom range uses that week, not the last 7 days', async () => {
    const repo = await freshRepo();
    await repo.createItem({ sourceType: 'note', title: 'last week', capturedAt: '2026-10-14T10:00:00Z' });
    await repo.createItem({ sourceType: 'note', title: 'this week', capturedAt: '2026-10-21T10:00:00Z' });
    const sel = await selectReportItems(repo, { kind: 'weekly', custom: { from: '2026-10-12', to: '2026-10-18' } }, NOW, 'UTC');
    expect(sel.items.map((i) => i.title)).toEqual(['last week']);
    expect(sel.range).toMatchObject({ firstDay: '2026-10-12', lastDay: '2026-10-18' });
  });
});
