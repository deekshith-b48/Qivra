import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parseExpansion } from '../../src/core/semantic';
import AiProvidersScreen from '../../src/screens/AiProvidersScreen';
import { getRepo } from '../../src/services/db';
import { getSecret, SECRET_KEYS } from '../../src/services/secure';
import { searchByMeaning } from '../../src/services/semantic';
import { getSettings } from '../../src/services/settings';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

const mockChat = jest.fn();
jest.mock('../../src/services/ai', () => {
  const actual = jest.requireActual('../../src/services/ai');
  return {
    ...actual,
    // A chat model (the user's Groq key) but no embedding model: meaning search rewrites the query.
    loadProvider: jest.fn(async () => ({ provider: { label: 'groq', chat: (...a: unknown[]) => mockChat(...a) }, reason: null, external: true, source: 'phone', embeddingModel: null })),
    loadEmbedder: jest.fn(async () => ({ provider: null, embeddingModel: null, reason: null })),
  };
});

beforeEach(() => {
  resetTestRepo();
  mockChat.mockReset();
});

test('query expansion replies are parsed safely', () => {
  expect(parseExpansion('Sure: ["vector store", "embeddings DB", "वेक्टर डेटाबेस", "Vector store", "vector database", 3]', 'vector database'))
    .toEqual(['vector store', 'embeddings DB', 'वेक्टर डेटाबेस']);
  expect(parseExpansion('no list here', 'x')).toEqual([]);
  expect(parseExpansion('["a","b","c","d","e","f","g","h"]', 'x')).toHaveLength(6);
  expect(parseExpansion(`["${'x'.repeat(80)}", "ok"]`, 'q')).toEqual(['ok']);
});

test('without embeddings, an English search finds a Hindi reel through the rewritten query (and caches it)', async () => {
  const repo = await getRepo();
  const { item: hindi } = await repo.createItem({ sourceType: 'instagram', title: 'Reel' });
  await repo.upsertTranscript({ itemId: hindi.id, language: 'hi', source: 'cloud_whisper', segments: [{ startMs: 2000, endMs: 5000, text: 'आज हम वेक्टर डेटाबेस समझेंगे' }] });
  await repo.createItem({ sourceType: 'note', title: 'Unrelated' });
  mockChat.mockResolvedValue({ content: '["vector store", "वेक्टर डेटाबेस"]', toolCalls: [], model: 'm', usage: {} });
  const hits = await searchByMeaning('vector database', 8);
  expect(hits.map((h) => h.itemId)).toEqual([hindi.id]);
  expect(hits[0].passages[0]).toMatchObject({ startMs: 2000, kind: 'transcript' });
  await searchByMeaning('vector database', 8);
  expect(mockChat).toHaveBeenCalledTimes(1); // second search uses the cached rewrite
  expect(await searchByMeaning('abc', 8)).toEqual([]); // too short to spend a model call on
});

test('Gemini key: verified and stored on success; a rejected key stores nothing', async () => {
  const calls: string[] = [];
  let status = 401;
  global.fetch = jest.fn(async (url: string) => {
    calls.push(url);
    const body = status === 200 ? { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] } : { error: { message: 'API key not valid' } };
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  }) as never;
  render(<ThemeProvider><AiProvidersScreen navigation={{ goBack: jest.fn(), navigate: jest.fn() } as never} route={{ key: 'a', name: 'AiProviders' } as never} /></ThemeProvider>);
  fireEvent.changeText(await screen.findByLabelText('Your Gemini API key'), 'AIza-bad');
  fireEvent.press(screen.getByRole('button', { name: 'Verify & save' }));
  expect(await screen.findByText(/Google rejected this key/)).toBeTruthy();
  expect(await getSecret(SECRET_KEYS.embedApiKey)).toBeNull();
  expect(calls[0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/embeddings');

  status = 200;
  fireEvent.changeText(screen.getByLabelText('Your Gemini API key'), 'AIza-good');
  fireEvent.press(screen.getByRole('button', { name: 'Verify & save' }));
  expect(await screen.findByText(/Search by meaning is on/)).toBeTruthy();
  expect(await getSecret(SECRET_KEYS.embedApiKey)).toBe('AIza-good');
  await waitFor(async () => expect((await getSettings()).ai.embed).toEqual({ enabled: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-embedding-001' }));
});
