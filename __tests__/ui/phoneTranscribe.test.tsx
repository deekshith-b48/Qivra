import { getRepo } from '../../src/services/db';
import { removeServerOnce, retryItemsNeedingKey, runDueJobs, schedulePipeline, wakeWaitingJobs } from '../../src/services/processing';
import { getSecret, setSecret, SECRET_KEYS } from '../../src/services/secure';
import { updateSettings } from '../../src/services/settings';
import X_VIDEO from '../fixtures/x-syndication-video.json';
import { resetTestRepo } from '../helpers/uiSetup';

// Phone-only: transcription goes to Groq with the user's own key.
jest.mock('../../src/services/processing', () => jest.requireActual('../../src/services/processing'));
jest.mock('../../src/services/ai', () => ({ aiInfo: jest.fn(async () => ({ enabled: false })), loadProvider: jest.fn(async () => ({ provider: null })) }));

const mockDeleted: string[] = [];
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  cacheDirectory: 'file:///data/cache/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 200_000 })),
  downloadAsync: jest.fn(async () => ({ status: 200 })),
  deleteAsync: jest.fn(async (uri: string) => void mockDeleted.push(uri)),
}));

const WHISPER = { language: 'english', duration: 9.3, text: 'Entering Twitter HQ.', segments: [{ start: 0.4, end: 3.1, text: ' Entering Twitter HQ.', no_speech_prob: 0.02 }] };
let groqCalls: { url: string; auth: string }[] = [];
let instagramPage = '<title>Instagram</title>';
let offline = false;
let xBlocked = false;

beforeEach(async () => {
  resetTestRepo();
  mockDeleted.length = 0;
  groqCalls = [];
  offline = false;
  xBlocked = false;
  await setSecret(SECRET_KEYS.aiApiKey, 'gsk_test_key');
  await updateSettings({ autoTranscribe: true, ai: { enabled: true, baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', externalConsent: true } });
  global.fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    if (offline) throw new TypeError('Network request failed');
    const res = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.includes('cdn.syndication.twimg.com')) return res(200, xBlocked ? '<html>Something went wrong</html>' : X_VIDEO);
    if (url.includes('/audio/transcriptions')) {
      groqCalls.push({ url, auth: init?.headers?.Authorization ?? '' });
      return res(200, WHISPER);
    }
    if (url.includes('instagram.com/p/')) return res(200, instagramPage);
    return res(404, '');
  }) as never;
});

async function settle(id: string) {
  const repo = await getRepo();
  for (let i = 0; i < 60; i++) {
    await runDueJobs(5_000);
    const item = await repo.getItem(id);
    if (item && ['READY', 'NEEDS_INPUT', 'FAILED_PERMANENT'].includes(item.status)) {
      const pending = await repo.listJobs({ itemId: id, statuses: ['queued', 'running'] });
      if (!pending.length) return item;
    }
    await new Promise((r) => setImmediate(r));
  }
  return (await getRepo()).getItem(id);
}

test('an X video is transcribed on the phone with the user\'s Groq key, and the download is removed', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/elonmusk/status/1585341984679469056' });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  const t = (await repo.listTranscripts(item.id)).find((x) => x.source === 'cloud_whisper');
  expect(t).toMatchObject({ language: 'en', provider: 'groq-whisper-large-v3-turbo' });
  expect((await repo.getSegments(t!.id))[0]).toMatchObject({ startMs: 400, text: 'Entering Twitter HQ.' });
  expect(groqCalls).toEqual([{ url: 'https://api.groq.com/openai/v1/audio/transcriptions', auth: 'Bearer gsk_test_key' }]);
  expect(mockDeleted.some((u) => u.startsWith('file:///data/cache/cloud-'))).toBe(true);
});

test('Instagram that will not share its video falls back to the caption; nothing is sent to Groq', async () => {
  instagramPage = '<div class="Caption"><a class="CaptionUsername">chef</a> Three-minute pasta: boil, toss, eat<div class="CaptionComments">';
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'instagram', url: 'https://www.instagram.com/reel/C5ZyJm0P8Z8/' });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  expect(done?.metadata?.description).toBe('Three-minute pasta: boil, toss, eat');
  expect(done?.errorMessage).toMatch(/Using the post caption/);
  expect(groqCalls).toHaveLength(0);
});

test('an imported audio file is transcribed on the phone when no server is paired', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'file', title: 'Meeting.m4a' });
  await repo.addMedia(item.id, { uri: 'file:///data/files/media/meeting.m4a', name: 'meeting.m4a', mime: 'audio/mp4', size: 200_000 });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  expect((await repo.listTranscripts(item.id)).map((x) => x.source)).toContain('cloud_whisper');
  expect(mockDeleted).not.toContain('file:///data/files/media/meeting.m4a'); // the user's own file is kept
});

test('without a Groq key, the item asks for one instead of a server', async () => {
  await updateSettings({ ai: { enabled: false } });
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1585341984679469056' });
  await repo.updateItem(item.id, { metadata: { fetchedAt: '2026-10-24T00:00:00Z', provider: 'x-oembed' } });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done).toMatchObject({ status: 'NEEDS_INPUT', errorCode: 'NO_TRANSCRIBER' });
  expect(done?.errorMessage).toMatch(/Groq key/);
});

test('a phone paired with the old laptop server forgets it once and re-runs stuck videos on the phone', async () => {
  const repo = await getRepo();
  await setSecret(SECRET_KEYS.deviceToken, 'qv1_old');
  await repo.setMeta('server.connection', JSON.stringify({ serverUrl: 'http://192.168.1.20:5001', deviceId: 'd1' }));
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1585341984679469056' });
  await repo.setStatus(item.id, 'METADATA_CHECK');
  await repo.setStatus(item.id, 'TRANSCRIBING', { code: 'INFO_TRANSCRIBING', message: 'Transcribing on your Qivra server…' });
  await repo.enqueueJob({ id: `job_server_transcribe_url_${item.id}`, kind: 'server_transcribe_url', itemId: item.id, retry: true, maxAttempts: 4 });
  expect(await removeServerOnce(repo)).toBe(1);
  expect(await getSecret(SECRET_KEYS.deviceToken)).toBeNull();
  expect(await repo.getMeta('server.connection')).toBe('null');
  expect(await repo.listJobs({ itemId: item.id, statuses: ['queued'] })).not.toContainEqual(expect.objectContaining({ kind: 'server_transcribe_url' }));
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  expect((await repo.listTranscripts(item.id)).map((t) => t.source)).toContain('cloud_whisper');
  expect(await removeServerOnce(repo)).toBe(0); // only once
});

test('offline: the video waits for the internet without using up attempts, then finishes on its own', async () => {
  const repo = await getRepo();
  offline = true;
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1585341984679469056' });
  await schedulePipeline(item.id);
  let job = null;
  for (let i = 0; i < 60 && job?.lastErrorCode !== 'WAITING_FOR_NETWORK'; i++) {
    await runDueJobs(2_000);
    await new Promise((r) => setImmediate(r));
    job = await repo.getJob(`job_cloud_transcribe_${item.id}`);
  }
  for (let i = 0; i < 3; i++) {
    await wakeWaitingJobs(repo); // as when the app is reopened, several times while still offline
    await runDueJobs(2_000);
  }
  job = await repo.getJob(`job_cloud_transcribe_${item.id}`);
  expect(job).toMatchObject({ status: 'queued', attempts: 0, lastErrorCode: 'WAITING_FOR_NETWORK' });
  expect((await repo.getItem(item.id))?.errorMessage).toBe('Waiting for internet…');
  offline = false;
  await wakeWaitingJobs(repo);
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  expect(groqCalls).toHaveLength(1);
});

test('an unreadable reply is a normal failure that uses up attempts, not an endless wait for the internet', async () => {
  const repo = await getRepo();
  xBlocked = true;
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1585341984679469056' });
  await schedulePipeline(item.id);
  let job = null;
  for (let i = 0; i < 60 && !job?.lastErrorCode; i++) {
    await runDueJobs(2_000);
    await new Promise((r) => setImmediate(r));
    job = await repo.getJob(`job_cloud_transcribe_${item.id}`);
  }
  expect(job).toMatchObject({ lastErrorCode: 'INTERNAL', attempts: 1, status: 'failed_retryable' });
  expect((await repo.getItem(item.id))?.errorMessage).not.toBe('Waiting for internet…');
});

test('videos shared before the Groq key was added are transcribed once the key is saved', async () => {
  const repo = await getRepo();
  await updateSettings({ ai: { enabled: false } });
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1585341984679469056' });
  await repo.updateItem(item.id, { metadata: { fetchedAt: '2026-10-24T00:00:00Z', provider: 'x-oembed' } }); // no post text
  await schedulePipeline(item.id);
  expect(await settle(item.id)).toMatchObject({ status: 'NEEDS_INPUT', errorCode: 'NO_TRANSCRIBER' });
  await updateSettings({ ai: { enabled: true } }); // the user adds their key (stored in beforeEach)
  expect(await retryItemsNeedingKey()).toBe(1);
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  expect((await repo.listTranscripts(item.id)).map((t) => t.source)).toContain('cloud_whisper');
});
