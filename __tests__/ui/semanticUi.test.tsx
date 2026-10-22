import { render, screen } from '@testing-library/react-native';
import { getRepo } from '../../src/services/db';
import { searchByMeaning } from '../../src/services/semantic';
import { SearchResults } from '../../src/ui/SearchResults';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

jest.mock('../../src/services/semantic', () => ({ searchByMeaning: jest.fn(async () => []), similarItems: jest.fn(async () => []) }));

beforeEach(() => resetTestRepo());

test('library search adds items found by meaning (no shared words), without repeating keyword hits', async () => {
  const repo = await getRepo();
  const { item: hindi } = await repo.createItem({ sourceType: 'note', title: 'डेटाबेस क्वेरी को तेज़ कैसे करें' });
  const { item: kw } = await repo.createItem({ sourceType: 'note', title: 'Postgres indexes explained' });
  jest.mocked(searchByMeaning).mockResolvedValue([
    { itemId: kw.id, score: 0.8, passages: [] },
    { itemId: hindi.id, score: 0.6, passages: [{ text: 'डेटाबेस…', startMs: null, kind: 'meta', language: 'hi' }] },
  ]);
  render(<ThemeProvider><SearchResults query="postgres indexes" onOpen={jest.fn()} /></ThemeProvider>);
  expect(await screen.findByText('RELATED BY MEANING', {}, { timeout: 3000 })).toBeTruthy();
  expect(screen.getByText('डेटाबेस क्वेरी को तेज़ कैसे करें')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Postgres indexes explained' })).toHaveLength(1); // keyword hit is not repeated
});
