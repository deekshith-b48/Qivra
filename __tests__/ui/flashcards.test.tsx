import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type React from 'react';
import { resetTestRepo } from '../helpers/uiSetup';
import { getRepo } from '../../src/services/db';
import { ThemeProvider } from '../../src/ui/theme';
import type { Enrichment } from '../../src/core/enrich';
import { dueCount, makeCards } from '../../src/services/flashcards';
import ReviewScreen from '../../src/screens/ReviewScreen';
import TodayScreen from '../../src/screens/TodayScreen';
import CollectionsScreen from '../../src/screens/CollectionsScreen';
import ItemDetailScreen from '../../src/screens/ItemDetailScreen';

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn(), replace: jest.fn(), push: jest.fn(), setParams: jest.fn() } as never;
}
const wrap = (el: React.ReactElement) => render(<ThemeProvider>{el}</ThemeProvider>);

beforeEach(() => resetTestRepo());

const enrichment: Enrichment = {
  origin: 'model', version: 1, provider: 'test', generatedAt: '2026-10-22T00:00:00Z', summary: 'GIN indexes.', tldr: 'Postgres GIN indexes make JSONB queries fast.',
  keyPoints: ['Use a GIN index for JSONB documents.', 'A B-tree index suits equality and range lookups.'],
  keyMoments: [{ text: 'Use a GIN index for JSONB documents.', startMs: 62000 }, { text: 'A B-tree index suits equality and range lookups.', startMs: null }],
  concepts: ['GIN index', 'B-tree index'], tools: [], commands: [], repos: [], urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [],
};

async function itemWithEnrichment(title = 'Postgres indexing') {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', title, url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  await repo.updateItem(item.id, { enrichment });
  return item;
}

test('makeCards falls back to cloze cards without an AI model and never duplicates', async () => {
  const item = await itemWithEnrichment();
  const r = await makeCards(item.id);
  expect(r).toMatchObject({ added: 2, total: 2, origin: 'local' });
  const cards = await (await getRepo()).listCards(item.id);
  expect(cards.map((c) => [c.front, c.back, c.startMs])).toEqual([
    ['Use a _____ for JSONB documents.', 'GIN index', 62000],
    ['A _____ suits equality and range lookups.', 'B-tree index', null],
  ]);
  expect(await makeCards(item.id)).toMatchObject({ added: 0, total: 2 });
  expect(await dueCount()).toBe(2);
});

test('item page makes flashcards and says how many', async () => {
  const item = await itemWithEnrichment();
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: 'Make flashcards' }));
  expect(await screen.findByText(/2 cards made on this phone · 2 in total/)).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Review' })).toBeTruthy();
});

test('review: reveal, jump to the moment, grade, done for today', async () => {
  const item = await itemWithEnrichment();
  await makeCards(item.id);
  const n = nav() as { navigate: jest.Mock };
  wrap(<ReviewScreen navigation={n as never} route={{ key: 'r', name: 'Review' } as never} />);
  expect(await screen.findByText('Use a _____ for JSONB documents.')).toBeTruthy();
  expect(screen.getByText('0 reviewed · 2 left')).toBeTruthy();
  expect(screen.queryByText('GIN index')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Show answer' }));
  expect(screen.getByText('GIN index')).toBeTruthy();
  fireEvent.press(screen.getByRole('link', { name: 'Play from 1:02' }));
  expect(n.navigate).toHaveBeenCalledWith('ItemDetail', { id: item.id, at: 62000 });
  fireEvent.press(screen.getByRole('button', { name: 'Good' }));
  expect(await screen.findByText('A _____ suits equality and range lookups.')).toBeTruthy();
  expect(screen.getByText('1 reviewed · 1 left')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Show answer' }));
  fireEvent.press(screen.getByRole('button', { name: 'Easy' }));
  expect(await screen.findByText('Done for today')).toBeTruthy();
  expect(screen.getByText(/You reviewed 2 cards/)).toBeTruthy();
  expect(await dueCount()).toBe(0);
  const cards = await (await getRepo()).listCards(item.id);
  expect(cards.map((c) => c.reps)).toEqual([1, 1]);
});

test('home shows the due-cards card only when cards are due', async () => {
  const item = await itemWithEnrichment();
  const n = nav() as { navigate: jest.Mock };
  const first = wrap(<TodayScreen navigation={n as never} route={{ key: 't', name: 'Today' } as never} />);
  expect(await screen.findByText("Today's digest")).toBeTruthy();
  expect(screen.queryByText(/cards? due/)).toBeNull();
  first.unmount();
  await makeCards(item.id);
  wrap(<TodayScreen navigation={n as never} route={{ key: 't', name: 'Today' } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: '2 flashcards due. Review' }));
  expect(n.navigate).toHaveBeenCalledWith('Review');
});

test('collections: suggested smart collection with ✨ badge, live count and Study', async () => {
  const repo = await getRepo();
  for (const t of ['A', 'B', 'C']) await itemWithEnrichment(t);
  const n = nav() as { navigate: jest.Mock };
  wrap(<CollectionsScreen navigation={n as never} route={{ key: 'c', name: 'Collections' } as never} />);
  expect(await screen.findByText('Suggested')).toBeTruthy();
  expect(screen.getByText('✨ gin index')).toBeTruthy();
  expect(screen.getAllByText('3 items share this concept').length).toBe(2);
  fireEvent.press(screen.getAllByRole('button', { name: 'Create' })[0]);
  expect(await screen.findByLabelText('Smart collection b-tree index, 3 items')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('✨ b-tree index')).toBeTruthy());
  const col = (await repo.listCollections())[0];
  expect(col.rules).toEqual({ concepts: ['b-tree index'] });
  fireEvent.press(screen.getAllByRole('button', { name: 'Study b-tree index' }).at(-1)!);
  expect(n.navigate).toHaveBeenCalledWith('Review', { collectionId: col.id });
});

test('collections: rule builder sheet shows a live count and creates a smart collection', async () => {
  await itemWithEnrichment('One');
  const repo = await getRepo();
  await repo.createItem({ sourceType: 'note', title: 'Plain note' });
  wrap(<CollectionsScreen navigation={nav()} route={{ key: 'c', name: 'Collections' } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: 'New smart collection' }));
  expect(await screen.findByText('Pick at least one rule.')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Name'), 'Videos');
  fireEvent.press(screen.getByRole('button', { name: 'YouTube' }));
  expect(await screen.findByText(/^1 matching item · /)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Saved within 7 days' }));
  fireEvent.press(screen.getByRole('button', { name: 'gin index' }));
  expect(await screen.findByText('1 matching item · youtube · gin index · last 7 days')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Unread' }));
  fireEvent.press(screen.getByRole('button', { name: 'Create' }));
  await waitFor(async () => expect((await repo.listCollections()).map((c) => c.name)).toEqual(['Videos']));
  expect((await repo.listCollections())[0].rules).toEqual({ sourceTypes: ['youtube'], concepts: ['gin index'], savedWithinDays: 7, unread: true });
});
