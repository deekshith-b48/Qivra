import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import AboutScreen from '../../src/screens/AboutScreen';
import HighlightsScreen from '../../src/screens/HighlightsScreen';
import ItemDetailScreen from '../../src/screens/ItemDetailScreen';
import LibraryScreen from '../../src/screens/LibraryScreen';
import SettingsScreen from '../../src/screens/SettingsScreen';
import { getRepo } from '../../src/services/db';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn(), setOptions: jest.fn(), isFocused: () => true } as never;
}
const wrap = (el: React.ReactElement) => render(<ThemeProvider>{el}</ThemeProvider>);
beforeEach(() => resetTestRepo());

async function video() {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Hooks tutorial', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', languageMethod: 'provider', source: 'youtube_captions', provider: 'youtube-captions', segments: [
    { startMs: 61000, endMs: 64000, text: 'Hooks run before packaging.' },
  ] });
  return item;
}

test('long-press a transcript line to save it as a highlight; it shows on the item and in Highlights', async () => {
  const item = await video();
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  fireEvent.press(await screen.findByRole('tab', { name: /^Transcript/ }));
  fireEvent(await screen.findByText('Hooks run before packaging.'), 'longPress');
  fireEvent.press(await screen.findByRole('button', { name: 'Save highlight' }));
  await waitFor(async () => expect((await (await getRepo()).listHighlights()).map((h) => [h.text, h.startMs])).toEqual([['Hooks run before packaging.', 61000]]));
  screen.unmount();
  wrap(<HighlightsScreen navigation={nav()} route={{ key: 'h', name: 'Highlights' } as never} />);
  expect(await screen.findByText('1 saved quote')).toBeTruthy();
  expect(screen.getByText('Hooks run before packaging.')).toBeTruthy();
});

test('star an item and find it on the Favourites shelf', async () => {
  const item = await video();
  const repo = await getRepo();
  await repo.createItem({ sourceType: 'youtube', title: 'Other video', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: 'Add to favourites' }));
  expect(await screen.findByRole('button', { name: 'Remove from favourites' })).toBeTruthy();
  screen.unmount();
  wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: 'Favourites, 1' }));
  await waitFor(() => expect(screen.queryByText('Other video')).toBeNull(), { timeout: 5000 }); // the list reloads after the shelf changes
  expect(screen.getAllByText(/Hooks tutorial/).length).toBeGreaterThan(0);
});

test('a reminder preset schedules a notification that opens the item', async () => {
  const item = await video();
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({ granted: true, canAskAgain: true } as never);
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: 'Remind me to revisit' }));
  fireEvent.press(await screen.findByRole('button', { name: /^Tomorrow morning/ }));
  await waitFor(() => expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled());
  const call = jest.mocked(Notifications.scheduleNotificationAsync).mock.calls.at(-1)![0];
  expect(call.content.data).toEqual({ url: `qivra://item/${item.id}` });
  await waitFor(async () => expect((await (await getRepo()).getItem(item.id))?.remindAt).not.toBeNull());
});

test('settings rows open their screens', async () => {
  const n = nav() as { navigate: jest.Mock };
  wrap(<SettingsScreen navigation={n as never} route={{ key: 's', name: 'Settings' } as never} />);
  fireEvent.press(await screen.findByRole('button', { name: /^Highlights/ }));
  expect(n.navigate).toHaveBeenLastCalledWith('Highlights');
  fireEvent.press(screen.getByRole('button', { name: /^Your Qivra server/ }));
  expect(n.navigate).toHaveBeenLastCalledWith('ConnectServer');
  fireEvent.press(screen.getByRole('button', { name: /^Time zone/ }));
  expect(await screen.findByText(/Use this phone's time zone/)).toBeTruthy();
});

test('About shows the license, copyright and no-warranty notices, and no upstream product name', async () => {
  wrap(<AboutScreen navigation={nav()} route={{ key: 'a', name: 'About' } as never} />);
  fireEvent.press(screen.getByRole('button', { name: /^Open-source licenses/ }));
  expect(screen.getByText(/GNU Affero General Public License/)).toBeTruthy();
  expect(screen.getByText(/no warranty/)).toBeTruthy();
  expect(screen.getByText('View notices')).toBeTruthy();
  expect(screen.queryByText(/SuperBrain/i)).toBeNull();
});

test('a keyword on a GitHub README filters its paragraphs, not the whole raw Markdown', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'github', url: 'https://github.com/a/b', title: 'a/b' });
  await repo.updateItem(item.id, { enrichment: { origin: 'local', version: 1, provider: 't', generatedAt: '2026-10-01T00:00:00Z', summary: '', keyPoints: [], concepts: [], tools: ['pip'], commands: [], repos: [], urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [] } as never });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', languageMethod: 'heuristic', kind: 'original', source: 'github_readme', provider: 'github-api', format: 'md',
    segments: [{ startMs: null, endMs: null, text: '# Title\n\nInstall with **pip** today.\n\nUse the GPU flag for speed.' }] });
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  fireEvent.press(await screen.findByRole('tab', { name: 'Details' }));
  fireEvent.press(await screen.findByRole('button', { name: 'pip' })); // tools chip: open the README filtered to "pip"
  expect(await screen.findByText('Showing lines with “pip” ✕')).toBeTruthy();
  expect(screen.getByText('Install with pip today.')).toBeTruthy();
  expect(screen.queryByText(/GPU flag/)).toBeNull();
  expect(screen.queryByText(/\*\*|^#/)).toBeNull();
});
