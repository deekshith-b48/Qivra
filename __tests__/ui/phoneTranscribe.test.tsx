import { getRepo } from '../../src/services/db';
import { DownloadError } from '../../src/services/downloader';
import { englishOnlyOnce, removeServerOnce, requestTranslation, retryItemsNeedingKey, runDueJobs, schedulePipeline, summaryTranslationKey, wakeWaitingJobs } from '../../src/services/processing';
import { getSecret, setSecret, SECRET_KEYS } from '../../src/services/secure';
import { updateSettings } from '../../src/services/settings';
import X_VIDEO from '../fixtures/x-syndication-video.json';
import YT_CAPTIONS from '../fixtures/youtube-player-captions.json';
import YT_NO_CAPTIONS from '../fixtures/youtube-player-nocaptions.json';
import { resetTestRepo } from '../helpers/uiSetup';

// Phone-only: transcription goes to Groq with the user's own key.
jest.mock('../../src/services/processing', () => jest.requireActual('../../src/services/processing'));
// The chat model (for translation) is off unless a test turns it on.
let mockAiOn = false;
const mockChat = jest.fn();
jest.mock('../../src/services/ai', () => ({
  aiInfo: jest.fn(async () => ({ enabled: mockAiOn, autoEnrich: false, embeddingModel: null })),
  loadProvider: jest.fn(async () => ({ provider: mockAiOn ? { label: 'groq · test', chat: (...a: unknown[]) => mockChat(...a) } : null, reason: mockAiOn ? null : 'off' })),
}));

// yt-dlp on the phone (native module) for Instagram reels.
const mockReel = jest.fn();
jest.mock('../../src/services/downloader', () => ({ ...jest.requireActual('../../src/services/downloader'), downloadReelAudio: (...a: unknown[]) => mockReel(...a) }));

const mockDeleted: string[] = [];
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  cacheDirectory: 'file:///data/cache/',
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 200_000 })),
  downloadAsync: jest.fn(async (url: string) => {
    downloads.push(url);
    return { status: 200 };
  }),
  deleteAsync: jest.fn(async (uri: string) => void mockDeleted.push(uri)),
}));

let whisperReply: unknown = null;
const WHISPER = { language: 'english', duration: 9.3, text: 'Entering Twitter HQ.', segments: [{ start: 0.4, end: 3.1, text: ' Entering Twitter HQ.', no_speech_prob: 0.02 }] };
let groqCalls: { url: string; auth: string }[] = [];
let offline = false;
let xBlocked = false;
let groqStatus = 200;
const downloads: string[] = [];

beforeEach(async () => {
  resetTestRepo();
  mockDeleted.length = 0;
  groqCalls = [];
  offline = false;
  xBlocked = false;
  await setSecret(SECRET_KEYS.aiApiKey, 'gsk_test_key');
  await updateSettings({ autoTranscribe: true, ai: { enabled: true, baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', externalConsent: true } });
  groqStatus = 200;
  whisperReply = null;
  mockAiOn = false;
  mockChat.mockReset();
  downloads.length = 0;
  mockReel.mockReset();
  global.fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    if (offline) throw new TypeError('Network request failed');
    const res = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.includes('cdn.syndication.twimg.com')) return res(200, xBlocked ? '<html>Something went wrong</html>' : X_VIDEO);
    if (url.includes('/audio/translations')) {
      groqCalls.push({ url, auth: init?.headers?.Authorization ?? '' });
      return groqStatus === 200 ? res(200, whisperReply ?? WHISPER) : res(groqStatus, { error: { message: 'Invalid API Key' } });
    }
    if (url.includes('youtubei/v1/player')) return res(200, String(init?.body).includes('jNQXAC9IVRw') ? YT_CAPTIONS : YT_NO_CAPTIONS);
    if (url.includes('/api/timedtext')) return res(200, '<?xml version="1.0"?><timedtext format="3"><body><p t="1200" d="2500">All right, so here we are</p><p t="4000" d="3000">in front of the elephants</p></body></timedtext>');
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
  expect(t).toMatchObject({ language: 'en', provider: 'groq-whisper-large-v3' });
  expect((await repo.getSegments(t!.id))[0]).toMatchObject({ startMs: 400, text: 'Entering Twitter HQ.' });
  expect(groqCalls).toEqual([{ url: 'https://api.groq.com/openai/v1/audio/translations', auth: 'Bearer gsk_test_key' }]); // speech → English
  expect(mockDeleted.some((u) => u.startsWith('file:///data/cache/cloud-'))).toBe(true);
});

test('an Instagram reel is downloaded on the phone (yt-dlp), transcribed in English, and the download removed', async () => {
  const repo = await getRepo();
  mockReel.mockResolvedValue({ uri: 'file:///data/cache/ytdl/DcY6Ltcyo7B.m4a', path: '/data/cache/ytdl/DcY6Ltcyo7B.m4a', mime: 'audio/mp4', title: 'Video by ai.explained', description: 'RAG in 60 seconds', durationMs: 9300 });
  const { item } = await repo.createItem({ sourceType: 'instagram', url: 'https://www.instagram.com/reel/DcY6Ltcyo7B/' });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done?.status).toBe('READY');
  expect(mockReel).toHaveBeenCalledWith('https://www.instagram.com/reel/DcY6Ltcyo7B/');
  expect((await repo.listTranscripts(item.id)).map((t) => [t.source, t.language])).toEqual([['cloud_whisper', 'en']]);
  expect(done?.metadata?.description).toBe('RAG in 60 seconds');
  expect(mockDeleted).toContain('file:///data/cache/ytdl/DcY6Ltcyo7B.m4a');
});

test('a reel Instagram refuses to share offers Retry; nothing is sent to Groq', async () => {
  const repo = await getRepo();
  mockReel.mockRejectedValue(new DownloadError('BLOCKED', 'Instagram blocked this download (it asks apps to sign in, or the reel is private). Try again later.'));
  const { item } = await repo.createItem({ sourceType: 'instagram', url: 'https://www.instagram.com/reel/DcY6Ltcyo7B/' });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done).toMatchObject({ status: 'NEEDS_INPUT', errorCode: 'INSTAGRAM_BLOCKED' });
  expect(done?.errorMessage).toMatch(/Instagram blocked this download/);
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

test('YouTube with captions uses the captions and never calls Groq', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  await schedulePipeline(item.id);
  expect((await settle(item.id))?.status).toBe('READY');
  expect((await repo.listTranscripts(item.id)).map((t) => t.source)).toEqual(['youtube_captions']);
  expect(groqCalls).toHaveLength(0);
});

test('YouTube without captions says why and asks for a transcript; nothing is downloaded or sent to Groq', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', url: 'https://youtu.be/aqz-KE-bpKQ' });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  expect(done).toMatchObject({ status: 'NEEDS_INPUT', errorCode: 'YOUTUBE_NO_CAPTIONS' });
  expect(done?.errorMessage).toMatch(/no captions on YouTube.*import a transcript/);
  expect(downloads).toEqual([]);
  expect(groqCalls).toHaveLength(0);
});

test('a key Groq rejects asks for a new key (instead of finishing as "no speech"), so saving a key re-runs it', async () => {
  const repo = await getRepo();
  groqStatus = 401;
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1585341984679469056' });
  await schedulePipeline(item.id);
  expect(await settle(item.id)).toMatchObject({ status: 'NEEDS_INPUT', errorCode: 'AUTH' });
  groqStatus = 200;
  expect(await retryItemsNeedingKey()).toBe(1);
  expect((await settle(item.id))?.status).toBe('READY');
});

test('a Hindi transcript is replaced by its English translation (same timestamps), and the summary is in English', async () => {
  const repo = await getRepo();
  mockAiOn = true;
  mockChat.mockResolvedValue({ content: '["Today we will learn about vector databases", "It makes search faster"]', toolCalls: [], model: 'm', usage: { promptTokens: 10, completionTokens: 10 } });
  // A Hindi voice note transcribed by Parakeet on the phone (Whisper writes English itself).
  const { item } = await repo.createItem({ sourceType: 'note', title: 'Voice note' });
  await repo.upsertTranscript({ itemId: item.id, language: 'hi', languageMethod: 'provider', kind: 'original', source: 'voice_on_device', provider: 'parakeet', format: 'wav', segments: [
    { startMs: 0, endMs: 3000, text: 'आज हम वेक्टर डेटाबेस सीखेंगे' },
    { startMs: 3000, endMs: 8000, text: 'यह खोज को तेज़ बनाता है' },
  ] });
  await schedulePipeline(item.id);
  const done = await settle(item.id);
  const all = await repo.listTranscripts(item.id);
  expect(all.map((t) => [t.language, t.source])).toEqual([['en', 'ai_translation']]); // English only: the Hindi original is gone
  expect((await repo.getSegments(all[0].id)).map((s) => [s.startMs, s.text])).toEqual([[0, 'Today we will learn about vector databases'], [3000, 'It makes search faster']]);
  expect(done?.summary).toMatch(/vector databases|search faster/i);
  expect(mockChat).toHaveBeenCalledTimes(1);
});

test('on request, the English transcript and summary are translated into Kannada (timestamps kept)', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  await schedulePipeline(item.id);
  expect((await settle(item.id))?.status).toBe('READY');
  mockAiOn = true;
  mockChat.mockImplementation(async (msgs: { content: string }[]) => ({
    content: msgs[0].content.includes('summary')
      ? JSON.stringify({ tldr: 'ಆನೆಗಳ ಮುಂದೆ', summary: 'ಆನೆಗಳ ಮುಂದೆ', moments: (JSON.parse(msgs[1].content).moments as string[]).map(() => 'ಕ್ಷಣ') })
      : '["ಸರಿ, ನಾವು ಇಲ್ಲಿದ್ದೇವೆ", "ಆನೆಗಳ ಮುಂದೆ"]',
    toolCalls: [], model: 'm', usage: { promptTokens: 1, completionTokens: 1 },
  }));
  await requestTranslation(item.id, 'kn');
  await settle(item.id);
  const kn = (await repo.listTranscripts(item.id)).find((t) => t.language === 'kn');
  expect(kn).toMatchObject({ kind: 'translation', source: 'ai_translation' });
  expect((await repo.getSegments(kn!.id)).map((s) => [s.startMs, s.text])).toEqual([[1200, 'ಸರಿ, ನಾವು ಇಲ್ಲಿದ್ದೇವೆ'], [4000, 'ಆನೆಗಳ ಮುಂದೆ']]);
  expect(await repo.getJson(summaryTranslationKey(item.id, 'kn'), null)).toMatchObject({ tldr: 'ಆನೆಗಳ ಮುಂದೆ' });
  expect(mockChat.mock.calls[0][0][1].content).toContain('into Kannada');
});

test('older items: originals that already have an English translation are dropped, once', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'x', url: 'https://x.com/a/status/1' });
  const seg = [{ startMs: 0, endMs: 1000, text: 'नमस्ते' }];
  await repo.upsertTranscript({ itemId: item.id, language: 'hi', kind: 'original', source: 'cloud_whisper', segments: seg });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', kind: 'translation', source: 'ai_translation', segments: [{ ...seg[0], text: 'Hello' }] });
  await englishOnlyOnce(repo);
  expect((await repo.listTranscripts(item.id)).map((t) => t.language)).toEqual(['en']);
  expect(await englishOnlyOnce(repo)).toBe(0);
});
