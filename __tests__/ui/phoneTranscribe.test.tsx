import { getRepo } from '../../src/services/db';
import { runDueJobs, schedulePipeline } from '../../src/services/processing';
import { setSecret, SECRET_KEYS } from '../../src/services/secure';
import { updateSettings } from '../../src/services/settings';
import X_VIDEO from '../fixtures/x-syndication-video.json';
import { resetTestRepo } from '../helpers/uiSetup';

// Phone-only: no server is paired; transcription goes to Groq with the user's own key.
jest.mock('../../src/services/processing', () => jest.requireActual('../../src/services/processing'));
jest.mock('../../src/services/server', () => ({ getClient: jest.fn(async () => null), getConnection: jest.fn(async () => null), checkConnection: jest.fn() }));
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

beforeEach(async () => {
  resetTestRepo();
  mockDeleted.length = 0;
  groqCalls = [];
  await setSecret(SECRET_KEYS.aiApiKey, 'gsk_test_key');
  await updateSettings({ autoTranscribe: true, ai: { enabled: true, baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', externalConsent: true } });
  global.fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const res = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.includes('cdn.syndication.twimg.com')) return res(200, X_VIDEO);
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
