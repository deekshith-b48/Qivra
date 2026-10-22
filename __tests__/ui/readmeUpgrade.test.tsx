import { waitFor } from '@testing-library/react-native';
import { getRepo } from '../../src/services/db';
import { resetTestRepo } from '../helpers/uiSetup';

// The real job runner (uiSetup mocks processing for screen tests).
const processing = jest.requireActual('../../src/services/processing') as typeof import('../../src/services/processing');

beforeEach(() => {
  resetTestRepo();
  // GitHub refuses: unauthenticated rate limit.
  global.fetch = jest.fn(async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => '{"message":"API rate limit exceeded"}' })) as never;
});

test('a failed README upgrade keeps the repo details that were already saved', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'github', url: 'https://github.com/zackees/transcribe-anything', title: 'zackees/transcribe-anything' });
  await repo.updateItem(item.id, { metadata: { title: 'zackees/transcribe-anything', description: 'Multi-backend whisper app', imageUrl: 'https://opengraph.githubassets.com/1/zackees/transcribe-anything', siteName: 'GitHub', author: 'zackees', fetchedAt: '2026-10-01T00:00:00Z', provider: 'github-api' } });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', languageMethod: 'heuristic', kind: 'original', source: 'github_readme', provider: 'github-api', format: 'txt', segments: [{ startMs: null, endMs: null, text: 'Old plain README' }] });
  await processing.schedulePipeline(item.id); // starts the job runner itself
  await waitFor(async () => expect((await repo.listJobs({ itemId: item.id }))[0]?.status).toBe('succeeded'), { timeout: 8000 });
  const after = await repo.getItem(item.id);
  expect(after?.metadata).toMatchObject({ description: 'Multi-backend whisper app', provider: 'github-api' });
  expect(global.fetch).toHaveBeenCalled();
});
