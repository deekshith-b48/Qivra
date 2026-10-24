import * as FS from 'expo-file-system/legacy';
import { drainShareInbox } from '../../src/services/capture';
import { getRepo } from '../../src/services/db';
import { readyMessage } from '../../src/services/notify';
import { recoverIfIdle, runDueJobs } from '../../src/services/processing';
import { runShareTask } from '../../src/services/shareTask';
import { resetTestRepo } from '../helpers/uiSetup';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  makeDirectoryAsync: jest.fn(async () => undefined),
  writeAsStringAsync: jest.fn(async () => undefined),
  moveAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
}));
jest.mock('../../src/services/capture', () => ({ drainShareInbox: jest.fn() }));
jest.mock('../../src/services/processing', () => ({ runDueJobs: jest.fn(async () => 0), wakeWaitingJobs: jest.fn(async () => undefined), recoverIfIdle: jest.fn(async () => 0) }));

beforeEach(() => {
  resetTestRepo();
  jest.clearAllMocks();
});

/** The JSON the native service will read (written to a .tmp name, then renamed to .json). */
function writtenResult(): { notes: { itemId: string; title: string; body: string }[] } {
  const [path, json] = jest.mocked(FS.writeAsStringAsync).mock.calls.at(-1) as [string, string];
  expect(path).toMatch(/^file:\/\/\/data\/files\/share_task\/result-.+\.tmp$/);
  const move = jest.mocked(FS.moveAsync).mock.calls.at(-1)![0];
  expect(move).toEqual({ from: path, to: path.replace(/\.tmp$/, '.json') });
  return JSON.parse(json);
}

async function newItem(status: string) {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', url: `https://www.youtube.com/watch?v=${Math.random().toString(36).slice(2, 13)}`, title: 'Hooks explained' });
  await repo.db.run('UPDATE items SET status = ? WHERE id = ?', [status, item.id]);
  return item.id;
}

test('processes a background share until ready and hands the service a Ready note', async () => {
  const id = await newItem('TRANSCRIBING');
  jest.mocked(drainShareInbox).mockResolvedValue({ results: [{ itemId: id, title: 'Hooks', kind: 'url', duplicate: false, status: 'CAPTURED' }], rejected: [] });
  let runs = 0;
  jest.mocked(runDueJobs).mockImplementation(async () => {
    if (++runs === 2) {
      const repo = await getRepo();
      await repo.db.run("UPDATE items SET status = 'READY' WHERE id = ?", [id]);
      await repo.updateItem(id, { summary: 'React hooks let components keep state. More detail follows.' });
    }
    return 1;
  });
  expect(await runShareTask({ budgetMs: 5_000, pollMs: 1 })).toEqual({ itemIds: [id], settled: true });
  expect(writtenResult().notes).toEqual([{ itemId: id, title: 'Ready: Hooks explained', body: 'React hooks let components keep state.' }]);
});

test('waits for the AI summary job, then reports what it has when time runs out', async () => {
  const id = await newItem('READY');
  const repo = await getRepo();
  await repo.enqueueJob({ id: `job_model_enrich_${id}`, kind: 'model_enrich', itemId: id, retry: true, maxAttempts: 3 });
  jest.mocked(drainShareInbox).mockResolvedValue({ results: [{ itemId: id, title: 'x', kind: 'url', duplicate: false, status: 'READY' }], rejected: [] });
  const r = await runShareTask({ budgetMs: 30, pollMs: 5 });
  expect(r.settled).toBe(false);
  expect(writtenResult().notes).toHaveLength(1);
});

test('always answers the service, even with nothing shared or on errors', async () => {
  jest.mocked(drainShareInbox).mockResolvedValue({ results: [], rejected: [] });
  expect(await runShareTask()).toEqual({ itemIds: [], settled: true });
  expect(runDueJobs).not.toHaveBeenCalled();
  expect(writtenResult().notes).toEqual([]);

  jest.mocked(drainShareInbox).mockRejectedValue(new Error('disk'));
  await expect(runShareTask()).rejects.toThrow('disk');
  expect(writtenResult().notes).toEqual([]);
});

test('notification text covers each outcome', () => {
  const base = { title: 'Reel', url: null, summary: '', errorCode: null, errorMessage: null };
  expect(readyMessage({ ...base, status: 'NEEDS_INPUT', errorMessage: 'No captions. Import one.' } as never)).toEqual({ title: 'Needs a transcript: Reel', body: 'No captions.' });
  expect(readyMessage({ ...base, status: 'READY' } as never).body).toBe('Saved to your library.');
  expect(readyMessage({ ...base, status: 'TRANSCRIBING' } as never).title).toBe('Saved: Reel');
  expect(readyMessage({ ...base, status: 'FAILED_PERMANENT' } as never).title).toBe('Could not finish: Reel');
});

test('a background share first recovers jobs left running by a killed app', async () => {
  jest.mocked(drainShareInbox).mockResolvedValue({ results: [], rejected: [] });
  jest.mocked(recoverIfIdle).mockClear();
  await runShareTask();
  expect(recoverIfIdle).toHaveBeenCalledTimes(1);
});
