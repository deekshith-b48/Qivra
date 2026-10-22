import { openNodeDriver } from '../helpers/nodeDriver';
import { migrate } from '../../src/db/schema';
import { Repo } from '../../src/db/repo';
import { applyRemote, resolveConflict } from '../../src/sync/engine';
import type { ServerEntity } from '../../src/core/api';

async function freshRepo() {
  const db = openNodeDriver(':memory:');
  await migrate(db);
  return new Repo(db);
}

const entity = (over: Partial<ServerEntity>): ServerEntity => ({
  kind: 'item', id: 'itm_remote1', revision: 1, seq: 1, deleted: false, data: { sourceType: 'note', title: 'Shell tips' },
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', updated_by: 'server', ...over,
});

test('commands in server enrichment keep the destructive warning', async () => {
  const repo = await freshRepo();
  await applyRemote(repo, entity({ data: { sourceType: 'note', title: 'Shell tips', enrichment: { commands: ['sudo rm -rf ~/', 'ls -la'] } } }));
  const cmds = (await repo.getItem('itm_remote1'))!.enrichment!.commands;
  expect(cmds.find((c) => c.command === 'sudo rm -rf ~/')?.destructive).toBe(true);
  expect(cmds.find((c) => c.command === 'ls -la')?.destructive).toBe(false);
});

test('an item deleted on another device hands back its local media files for removal', async () => {
  const repo = await freshRepo();
  await applyRemote(repo, entity({}));
  await repo.addMedia('itm_remote1', { uri: 'file:///media/a.m4a', name: 'a.m4a', mime: 'audio/mp4', size: 10 });
  const removed: string[] = [];
  expect(await applyRemote(repo, entity({ revision: 2, seq: 2, deleted: true }), removed)).toBe('purged');
  expect(removed).toEqual(['file:///media/a.m4a']);
});

test('a local edit to an item deleted elsewhere becomes a conflict; keeping the server side deletes it here', async () => {
  const repo = await freshRepo();
  await applyRemote(repo, entity({}));
  await repo.addMedia('itm_remote1', { uri: 'file:///media/b.jpg', name: 'b.jpg', mime: 'image/jpeg', size: 10 });
  await repo.updateItem('itm_remote1', { note: 'my edit' });
  expect(await applyRemote(repo, entity({ revision: 2, seq: 2, deleted: true, data: {} }))).toBe('conflict');
  const [c] = await repo.openConflicts();
  expect(c.remote).toEqual({ deleted: true });
  expect(await resolveConflict(repo, c.id, 'keep_remote')).toEqual(['file:///media/b.jpg']);
  expect(await repo.getItem('itm_remote1')).toBeNull();
});

test('"keep both" on an item deleted elsewhere keeps this phone\'s copy, media included, and re-sends it', async () => {
  const repo = await freshRepo();
  await applyRemote(repo, entity({}));
  await repo.addMedia('itm_remote1', { uri: 'file:///media/c.m4a', name: 'c.m4a', mime: 'audio/mp4', size: 10 });
  await repo.updateItem('itm_remote1', { note: 'my edit' });
  await applyRemote(repo, entity({ revision: 2, seq: 2, deleted: true, data: {} }));
  const [c] = await repo.openConflicts();
  expect(await resolveConflict(repo, c.id, 'keep_both')).toEqual([]);
  expect(await repo.getItem('itm_remote1')).toMatchObject({ note: 'my edit', syncStatus: 'pending' });
  expect(await repo.listMedia('itm_remote1')).toHaveLength(1);
});
