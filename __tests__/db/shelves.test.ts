import { openNodeDriver } from '../helpers/nodeDriver';
import { LATEST_VERSION, migrate } from '../../src/db/schema';
import { Repo } from '../../src/db/repo';

async function freshRepo() {
  const db = openNodeDriver(':memory:');
  await migrate(db);
  return new Repo(db);
}

test('v3 migration upgrades an existing v2 database without losing items', async () => {
  const db = openNodeDriver(':memory:');
  // Build a v2 database by running only the first two migrations, then add an item.
  const { MIGRATIONS } = require('../../src/db/schema');
  for (const m of MIGRATIONS.slice(0, 2)) await db.exec(m.sql);
  await db.exec('PRAGMA user_version = 2');
  const old = new Repo(db);
  const { item } = await old.createItem({ sourceType: 'note', title: 'Kept' });
  expect(await migrate(db)).toEqual({ from: 2, to: LATEST_VERSION });
  expect(await old.getItem(item.id)).toMatchObject({ title: 'Kept', favorite: false, remindAt: null });
});

test('favourites, unread/viewed shelves and counts', async () => {
  const repo = await freshRepo();
  const { item: a } = await repo.createItem({ sourceType: 'note', title: 'A' });
  const { item: b } = await repo.createItem({ sourceType: 'note', title: 'B' });
  await repo.setFavorite([a.id], true);
  await repo.markViewed(b.id);
  expect((await repo.listItems({ favorite: true })).map((i) => i.title)).toEqual(['A']);
  expect((await repo.listItems({ unread: true })).map((i) => i.title)).toEqual(['A']);
  expect((await repo.listItems({ viewed: true }, 'viewed')).map((i) => i.title)).toEqual(['B']);
  expect(await repo.shelfCounts()).toEqual({ favorites: 1, unread: 1, viewed: 1, highlights: 0 });
});

test('highlights: saved with timestamp, searchable, removed with their item', async () => {
  const repo = await freshRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Talk' });
  await repo.addHighlight({ itemId: item.id, text: '  Indexes make reads 100% faster ', startMs: 61000, source: 'transcript' });
  await repo.addHighlight({ itemId: item.id, text: 'Write less code', startMs: null, source: 'summary' });
  expect((await repo.listHighlights({ itemId: item.id })).map((h) => h.text)).toEqual(['Write less code', 'Indexes make reads 100% faster']);
  expect((await repo.listHighlights({ text: '100%' })).map((h) => h.startMs)).toEqual([61000]);
  expect(await repo.listHighlights({ text: '_' })).toEqual([]);
  await repo.deleteItems([item.id]);
  expect(await repo.listHighlights()).toEqual([]);
});

test('reminders: upcoming ones only, soonest first', async () => {
  const repo = await freshRepo();
  const { item: a } = await repo.createItem({ sourceType: 'note', title: 'Later' });
  const { item: b } = await repo.createItem({ sourceType: 'note', title: 'Soon' });
  const { item: c } = await repo.createItem({ sourceType: 'note', title: 'Past' });
  await repo.setReminder(a.id, '2026-11-02T09:00:00.000Z', 'n1');
  await repo.setReminder(b.id, '2026-10-25T09:00:00.000Z', 'n2');
  await repo.setReminder(c.id, '2026-10-01T09:00:00.000Z', 'n3');
  expect((await repo.upcomingReminders('2026-10-23T00:00:00.000Z')).map((i) => i.title)).toEqual(['Soon', 'Later']);
  expect(await repo.reminderNotificationId(a.id)).toBe('n1');
  await repo.setReminder(a.id, null, null);
  expect((await repo.getItem(a.id))?.remindAt).toBeNull();
});

test('dev toolbox gathers repos, tools and commands from summaries, skipping bad JSON', async () => {
  const repo = await freshRepo();
  const enr = (repos: string[], tools: string[], commands: { command: string; destructive: boolean; reason?: string }[]) => ({
    origin: 'local', version: 1, provider: 't', generatedAt: '2026-10-01T00:00:00Z', summary: '', keyPoints: [], concepts: [], tools, commands, repos, urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [],
  });
  const { item: a } = await repo.createItem({ sourceType: 'github', title: 'A' });
  const { item: b } = await repo.createItem({ sourceType: 'youtube', title: 'B' });
  await repo.updateItem(a.id, { enrichment: enr(['thedotmack/claude-mem'], ['Claude Code', 'MCP'], [{ command: 'npx claude-mem install', destructive: false }]) as never });
  await repo.updateItem(b.id, { enrichment: enr(['thedotmack/claude-mem', 'n8n-io/n8n'], ['Claude Code'], [{ command: 'rm -rf build', destructive: true, reason: 'deletes files' }]) as never });
  await repo.db.run(`UPDATE items SET enrichment_json = 'not json' WHERE id = ?`, [(await repo.createItem({ sourceType: 'note', title: 'C' })).item.id]);
  const t = await repo.devToolbox();
  expect(t.repos[0]).toMatchObject({ name: 'thedotmack/claude-mem', count: 2 });
  expect(t.repos[0].itemIds.sort()).toEqual([a.id, b.id].sort());
  expect(t.tools).toEqual([{ name: 'Claude Code', count: 2 }, { name: 'MCP', count: 1 }]);
  expect(t.commands.find((c) => c.command === 'rm -rf build')).toMatchObject({ destructive: true, reason: 'deletes files' });
  expect(await repo.metaKeys('dev.day.')).toEqual([]);
});
