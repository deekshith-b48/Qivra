import { normalizeShare } from '../../src/core/share';
import { drainShareInbox } from '../../src/services/capture';
import { getRepo } from '../../src/services/db';
import { ocrItemImages } from '../../src/services/ocr';
import { runDueJobs } from '../../src/services/processing';
import { resetTestRepo } from '../helpers/uiSetup';

// Exercise the real capture → job runner → OCR path (uiSetup mocks processing for screen tests).
jest.mock('../../src/services/processing', () => jest.requireActual('../../src/services/processing'));
jest.mock('../../src/services/ai', () => ({ aiInfo: jest.fn(async () => ({ enabled: false })), loadProvider: jest.fn(async () => ({ provider: null })) }));

const mockFiles = new Map<string, string>();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/files/',
  cacheDirectory: 'file:///data/cache/',
  getInfoAsync: jest.fn(async (uri: string) => ({ exists: uri.endsWith('/') || mockFiles.has(uri) })),
  makeDirectoryAsync: jest.fn(async () => undefined),
  readDirectoryAsync: jest.fn(async (dir: string) => [...mockFiles.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map((k) => k.slice(dir.length))),
  readAsStringAsync: jest.fn(async (uri: string) => mockFiles.get(uri) ?? ''),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockFiles.set(to, mockFiles.get(from) ?? '');
    mockFiles.delete(from);
  }),
  copyAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async (uri: string) => void mockFiles.delete(uri)),
}));

const mockRecognize = jest.fn();
jest.mock('@react-native-ml-kit/text-recognition', () => ({ __esModule: true, default: { recognize: (...a: unknown[]) => mockRecognize(...a) } }));

const INBOX = 'file:///data/files/share_inbox/';

function share(files: { name: string; mime: string }[], extra: Record<string, unknown> = {}) {
  const env = {
    version: 1, id: 'e1', action: files.length > 1 ? 'SEND_MULTIPLE' : 'SEND', receivedAt: '2026-10-22T10:00:00.000Z', errors: [],
    files: files.map((f, i) => {
      const path = `/data/files/share_inbox/files/f${i}.${f.name.split('.').pop()}`;
      mockFiles.set(`file://${path}`, 'img');
      return { path, name: f.name, mime: f.mime, size: 1234 };
    }),
    ...extra,
  };
  mockFiles.set(`${INBOX}e1.json`, JSON.stringify(env));
}

/** Capture already kicked the runner off; let it (and any re-runs) finish. */
async function settle(id: string) {
  const repo = await getRepo();
  for (let i = 0; i < 50; i++) {
    await runDueJobs(5_000);
    const job = await repo.getJob(`job_local_enrich_${id}`);
    if (job && ['succeeded', 'failed_permanent'].includes(job.status)) return;
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  resetTestRepo();
  mockFiles.clear();
  jest.clearAllMocks();
  mockRecognize.mockReset();
  jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('a shared screenshot becomes a note item whose OCR text is stored, summarised and searchable', async () => {
  const statusAtOcr: string[] = [];
  mockRecognize.mockImplementation(async (uri: string) => {
    const repo = await getRepo();
    const id = (await repo.db.get<{ item_id: string }>('SELECT item_id FROM media WHERE uri = ?', [uri]))!.item_id;
    statusAtOcr.push((await repo.getItem(id))!.status);
    return { text: 'Kubernetes   rollout tips\n\nUse kubectl rollout undo to revert a bad deploy.' };
  });
  share([{ name: 'Screenshot_2026.png', mime: 'image/png' }]);

  const { results } = await drainShareInbox();
  expect(results).toHaveLength(1);
  const id = results[0].itemId!;
  await settle(id);

  const repo = await getRepo();
  const item = (await repo.getItem(id))!;
  expect(item.sourceType).toBe('note');
  expect(item.title).toBe('Screenshot_2026');
  expect(item.status).toBe('READY');
  const media = await repo.listMedia(id);
  expect(media).toHaveLength(1);
  expect(media[0].uri).toMatch(/^file:\/\/\/data\/files\/media\/.+\.png$/);

  const [t] = await repo.listTranscripts(id);
  expect(t.source).toBe('image_ocr');
  expect(t.provider).toBe('mlkit-text-recognition');
  expect(t.text).toBe('Kubernetes rollout tips\nUse kubectl rollout undo to revert a bad deploy.');
  expect(mockRecognize).toHaveBeenCalledWith(media[0].uri, expect.any(String));

  // OCR ran before enrichment, so the summary and full-text search use the image text.
  expect(statusAtOcr).toEqual(['METADATA_CHECK']);
  expect(item.summary).toMatch(/kubectl|Kubernetes/);
  expect((await repo.searchChunks('kubectl')).map((h) => h.itemId)).toContain(id);
});

test('several images shared together become one carousel item with one segment per image, caption as note', async () => {
  mockRecognize.mockResolvedValueOnce({ text: 'Slide one: caching' }).mockResolvedValueOnce({ text: '' }).mockResolvedValueOnce({ text: 'Slide three: queues' });
  share([{ name: 'a.jpg', mime: 'image/jpeg' }, { name: 'b.jpg', mime: 'image/jpeg' }, { name: 'c.webp', mime: 'image/webp' }], { text: 'System design notes' });
  const { results } = await drainShareInbox();
  expect(results).toHaveLength(1);
  const id = results[0].itemId!;
  await settle(id);
  const repo = await getRepo();
  const item = (await repo.getItem(id))!;
  expect(item.note).toBe('System design notes');
  expect(item.title).toBe('System design notes');
  expect(await repo.listMedia(id)).toHaveLength(3);
  const [t] = await repo.listTranscripts(id);
  expect((await repo.getSegments(t.id)).map((s) => s.text).sort()).toEqual(['Slide one: caching', 'Slide three: queues']);
});

test('without the native module the item is still saved and says so honestly', async () => {
  mockRecognize.mockRejectedValue(new Error("The package '@react-native-ml-kit/text-recognition' doesn't seem to be linked."));
  share([{ name: 'photo.jpg', mime: 'image/jpeg' }]);
  const id = (await drainShareInbox()).results[0].itemId!;
  await settle(id);
  const repo = await getRepo();
  const item = (await repo.getItem(id))!;
  expect(item.status).toBe('READY');
  expect(item.errorCode).toBe('INFO_OCR_UNAVAILABLE');
  expect(await repo.listTranscripts(id)).toEqual([]);
});

test('OCR is idempotent and skips items without images', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'note', title: 'x', note: 'plain note' });
  expect(await ocrItemImages(repo, item, mockRecognize)).toBe('no_images');
  await repo.addMedia(item.id, { uri: 'file:///data/files/media/m1.png', name: 'm1.png', mime: 'image/png', size: 10 });
  mockRecognize.mockResolvedValue({ text: 'hello world' });
  expect(await ocrItemImages(repo, item, mockRecognize)).toBe('stored');
  expect(await ocrItemImages(repo, item, mockRecognize)).toBe('exists');
  expect(mockRecognize).toHaveBeenCalledTimes(1);
});

test('share normalisation accepts images, rejects oversized ones and SVG', () => {
  const base = { version: 1 as const, id: 'x', action: 'SEND_MULTIPLE' as const, receivedAt: '' };
  const r = normalizeShare({
    ...base,
    files: [
      { path: '/p/a.png', name: 'a.png', mime: 'image/png', size: 10 },
      { path: '/p/b.jpg', name: 'b.jpg', mime: 'image/jpeg', size: 40 * 1024 * 1024 },
      { path: '/p/c.svg', name: 'c.svg', mime: 'image/svg+xml', size: 10 },
    ],
  });
  expect(r.requests).toEqual([{ kind: 'images', files: [{ path: '/p/a.png', name: 'a.png', mime: 'image/png', size: 10 }], text: undefined, title: undefined }]);
  expect(r.rejected.map((x) => x.name)).toEqual(['b.jpg', 'c.svg']);
});
