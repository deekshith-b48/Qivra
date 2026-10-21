import { ApiError } from '../../src/core/api';
import { getRepo } from '../../src/services/db';
import { getClient } from '../../src/services/server';
import { resetTestRepo } from '../helpers/uiSetup';

// Exercise the real job runner (uiSetup mocks processing for screen tests).
const processing = jest.requireActual('../../src/services/processing') as typeof import('../../src/services/processing');

jest.mock('../../src/services/server', () => ({ getClient: jest.fn(), getConnection: jest.fn(async () => ({ serverUrl: 'http://192.168.1.2:5001' })), checkConnection: jest.fn() }));
jest.mock('../../src/sync/engine', () => ({ runSync: jest.fn(async () => undefined), enableSync: jest.fn(), disableSync: jest.fn() }));

beforeEach(() => {
  resetTestRepo();
  jest.clearAllMocks();
  // The runner arms a wake-up timer for the waiting job; keep it from holding Jest open.
  jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('an unreachable server keeps the transcription job waiting instead of failing it', async () => {
  jest.mocked(getClient).mockResolvedValue({ process: jest.fn(async () => { throw new ApiError('offline', 'offline'); }) } as never);
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'instagram', url: 'https://www.instagram.com/reel/abc123/', title: 'Reel' });
  const id = `job_server_transcribe_url_${item.id}`;
  await repo.enqueueJob({ id, kind: 'server_transcribe_url', itemId: item.id, retry: true, maxAttempts: 2 });
  for (let i = 0; i < 4; i++) {
    await processing.wakeServerJobs(repo);
    await processing.runDueJobs(2_000);
  }
  const job = (await repo.getJob(id))!;
  expect(job.status).toBe('queued');
  expect(job.attempts).toBe(0);
  expect(job.lastErrorCode).toBe('SERVER_UNREACHABLE');
  expect(Date.parse(job.runAfter)).toBeGreaterThan(Date.now() + 30_000);
});
