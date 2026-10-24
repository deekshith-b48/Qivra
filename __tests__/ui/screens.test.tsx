import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type React from 'react';
import { resetTestRepo } from '../helpers/uiSetup';
import { getRepo } from '../../src/services/db';
import { updateSettings } from '../../src/services/settings';
import { emit } from '../../src/services/events';
import { ThemeProvider, dark } from '../../src/ui/theme';
import OnboardingScreen from '../../src/screens/OnboardingScreen';
import LibraryScreen from '../../src/screens/LibraryScreen';
import ItemDetailScreen from '../../src/screens/ItemDetailScreen';
import AgentScreen from '../../src/screens/AgentScreen';
import ReportDetailScreen from '../../src/screens/ReportDetailScreen';
import CaptureScreen from '../../src/screens/CaptureScreen';
import TodayScreen from '../../src/screens/TodayScreen';
import { CaptureSheet, captureCopiedLink } from '../../src/ui/CaptureSheet';
import { digestMessage } from '../../src/core/digest';
import * as Clipboard from 'expo-clipboard';
import { generateReport } from '../../src/services/reports';

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn(), replace: jest.fn(), push: jest.fn(), setParams: jest.fn(), setOptions: jest.fn(), isFocused: () => true } as never;
}
const wrap = (el: React.ReactElement) => render(<ThemeProvider>{el}</ThemeProvider>);

beforeEach(() => resetTestRepo());

test('onboarding: Skip jumps to setup, Get started marks the app onboarded and opens the main tabs', async () => {
  const n = nav() as { reset: jest.Mock };
  wrap(<OnboardingScreen navigation={n as never} route={{ key: 'o', name: 'Onboarding' } as never} />);
  expect(screen.getByLabelText('Page 1 of 7')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Skip' }));
  expect(screen.getByLabelText('Page 7 of 7')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Get started' }));
  await waitFor(() => expect(n.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Main' }] }));
  expect(await (await getRepo()).getMeta('app.onboarded')).toBe('1');
});

test('onboarding setup: notifications ask for permission; there is no server step', async () => {
  const Notifications = require('expo-notifications');
  const ask = jest.spyOn(Notifications, 'requestPermissionsAsync').mockResolvedValue({ granted: true } as never);
  const n = nav() as { reset: jest.Mock };
  wrap(<OnboardingScreen navigation={n as never} route={{ key: 'o', name: 'Onboarding' } as never} />);
  fireEvent.press(screen.getByRole('button', { name: 'Notifications: Allow' }));
  expect(await screen.findByRole('button', { name: 'Notifications: Allowed' })).toBeTruthy();
  expect(ask).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /^AI answers/ })).toBeTruthy();
  expect(screen.queryByText(/your own server|laptop|Connect/)).toBeNull();
});

test('library has Videos / Websites / Notes sections and its search bar searches everything', async () => {
  wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
  expect(await screen.findByText('No videos yet')).toBeTruthy();
  const repo = await getRepo();
  await act(async () => {
    await repo.createItem({ sourceType: 'instagram', title: 'Reel about agents', url: 'https://www.instagram.com/reel/abc/' });
    await repo.createItem({ sourceType: 'github', title: 'anthropics/claude-code', url: 'https://github.com/anthropics/claude-code' });
    await repo.createItem({ sourceType: 'note', title: 'Pasta recipe' });
    emit('items');
  });
  expect(await screen.findByText('Reel about agents')).toBeTruthy();
  expect(screen.queryByText('anthropics/claude-code')).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: /Websites/ }));
  expect(await screen.findByText('anthropics/claude-code')).toBeTruthy();
  fireEvent.press(screen.getByRole('tab', { name: /Notes/ }));
  expect(await screen.findByText('Pasta recipe')).toBeTruthy();
  // Search runs across all sections (FTS), so the GitHub item is found while Notes is selected.
  fireEvent.changeText(screen.getByLabelText('Search your library'), 'claude');
  expect(await screen.findByText('anthropics/claude-code', {}, { timeout: 3000 })).toBeTruthy();
  expect(screen.queryByText('Pasta recipe')).toBeNull();
  fireEvent.changeText(screen.getByLabelText('Search your library'), 'nonexistentword');
  expect(await screen.findByText('No results', {}, { timeout: 3000 })).toBeTruthy();
});

test('video page: compact header, then Summary / Transcript / Details tabs; keyword chips open the filtered transcript', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Hooks tutorial', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', languageMethod: 'provider', source: 'youtube_captions', provider: 'youtube-captions', segments: [
    { startMs: 61000, endMs: 64000, text: 'Hooks run before packaging, so hooks matter.' },
    { startMs: 70000, endMs: 72000, text: 'Configure hooks in settings.' },
  ] });
  await repo.updateItem(item.id, {
    summary: 'Configure hooks before packaging.', summaryOrigin: 'local',
    enrichment: { origin: 'local', version: 1, provider: 'qivra-local-extractive', generatedAt: '2026-10-21T00:00:00Z', summary: 'Configure hooks.', keyPoints: ['Hooks run before packaging'], keyMoments: [{ text: 'Hooks run before packaging', startMs: 61000 }], concepts: [], tools: [], commands: [{ command: 'rm -rf build', destructive: true, reason: 'Recursively/forcibly deletes files' }], repos: [], urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [] },
  });
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  expect(await screen.findByText('Hooks tutorial')).toBeTruthy();
  await screen.findByRole('tab', { name: 'Transcript, 2' }); // the line count arrives with the transcript
  expect(screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual(['Summary', 'Transcript, 2', 'Details']);
  expect(screen.getByText('TL;DR')).toBeTruthy();
  expect(screen.getByText('Extracted on device')).toBeTruthy();
  expect(screen.queryByText('AI summary · generating…')).toBeNull();
  expect(screen.getByText('Key moments')).toBeTruthy();
  expect(screen.getByLabelText('Play from 1:01')).toBeTruthy(); // key moment timestamp is tappable on YouTube
  // The video plays inside the page, and a key moment seeks it there (no jump to the YouTube app).
  const linking = jest.spyOn(require('react-native').Linking, 'openURL');
  fireEvent.press(screen.getByLabelText('Play from 1:01'));
  expect(await screen.findByText('player:dQw4w9WgXcQ:playing')).toBeTruthy();
  await waitFor(() => expect(require('../helpers/youtubeMock').seekTo).toHaveBeenCalledWith(61, true));
  expect(linking).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Ask about this' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enrich on server' })).toBeNull();
  // The transcript is on its own tab; a keyword chip opens it filtered to that word.
  expect(screen.queryByText('1:10')).toBeNull();
  fireEvent.press(await screen.findByRole('button', { name: 'hooks' }));
  expect(await screen.findByText('Showing lines with “hooks” ✕')).toBeTruthy();
  expect(screen.getByText('1:10')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Transcript, 2' }).props.accessibilityState).toEqual({ selected: true });
  // Details (note, tags, commands…) are on the Details tab.
  expect(screen.queryByText(/Potentially destructive/)).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: 'Details' }));
  expect(await screen.findByText(/Potentially destructive/)).toBeTruthy();
  expect(screen.getByText('Your note')).toBeTruthy();
});

test('item page shows the generating state while an AI summary job is queued', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'web', title: 'An article', url: 'https://example.com/a' });
  await repo.updateItem(item.id, { summary: 'Local summary.', summaryOrigin: 'local' });
  await repo.enqueueJob({ id: `job_model_enrich_${item.id}`, kind: 'model_enrich', itemId: item.id, retry: true, maxAttempts: 3, runAfter: '2999-01-01T00:00:00Z' });
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  expect(await screen.findByText('AI summary · generating…')).toBeTruthy();
  expect(screen.getByText('Extracted on device')).toBeTruthy();
});

test('error banner offers one primary and one secondary action', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'instagram', title: 'Reel', url: 'https://www.instagram.com/reel/abc/' });
  await repo.setStatus(item.id, 'METADATA_CHECK');
  await repo.setStatus(item.id, 'NEEDS_INPUT', { code: 'SERVER_NOT_PAIRED', message: 'Pair your server.' });
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  // Items saved before 2.1 with SERVER_NOT_PAIRED now point to the Groq key, which works without a server.
  expect(await screen.findByText('Add your Groq key to transcribe')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add Groq key' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Import transcript' }).length).toBeGreaterThan(0);
  for (const extra of ['Retry', 'Try again']) expect(screen.queryByRole('button', { name: extra })).toBeNull();
});

test('ask answers from saved items without a model; sources open from the Sources sheet', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'note', title: 'Kubernetes operators notes', note: 'Operators reconcile desired state.' });
  const n = nav() as { navigate: jest.Mock };
  wrap(<AgentScreen navigation={n as never} route={{ key: 'a', name: 'Agent' } as never} />);
  fireEvent.changeText(await screen.findByLabelText('Message'), 'kubernetes operators');
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText(/From your saved items \(no AI model\)/, {}, { timeout: 4000 })).toBeTruthy();
  expect(screen.getByText('kubernetes operators')).toBeTruthy(); // the question as a chat bubble
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Sources (1)' }));
  fireEvent.press(await screen.findByLabelText(/Source S1: Kubernetes operators notes/));
  expect(n.navigate).toHaveBeenCalledWith('ItemDetail', { id: item.id, at: undefined });
});

test('report detail previews markdown and offers export', async () => {
  const repo = await getRepo();
  await repo.createItem({ sourceType: 'note', title: 'Saved today' });
  const r = await generateReport({ kind: 'daily' });
  wrap(<ReportDetailScreen navigation={nav()} route={{ key: 'r', name: 'ReportDetail', params: { id: r.id } } as never} />);
  expect(await screen.findByText(/Qivra Daily Report/)).toBeTruthy();
  expect(screen.getByText('Executive summary')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Export .md' })).toBeTruthy();
});

test('capture saves a link once and reports duplicates', async () => {
  const n = nav() as { replace: jest.Mock };
  wrap(<CaptureScreen navigation={n as never} route={{ key: 'cap', name: 'Capture' } as never} />);
  fireEvent.changeText(await screen.findByPlaceholderText(/YouTube, Instagram/), 'check https://youtu.be/dQw4w9WgXcQ?si=x');
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(n.replace).toHaveBeenCalledWith('ItemDetail', expect.anything()));
  expect(await (await getRepo()).countItems({})).toBe(1);
});

test('dark theme applies dark surfaces', async () => {
  await updateSettings({ theme: 'dark' });
  wrap(<OnboardingScreen navigation={nav()} route={{ key: 'o', name: 'Onboarding' } as never} />);
  await waitFor(() => {
    const title = screen.getByText(/Turn what you save/);
    expect(title.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: dark.text })]));
  });
});

test('text scales with the system font size (allowFontScaling is not disabled)', async () => {
  wrap(<OnboardingScreen navigation={nav()} route={{ key: 'o', name: 'Onboarding' } as never} />);
  const t = await screen.findByText(/Turn what you save/);
  expect(t.props.allowFontScaling).not.toBe(false);
});


test('home shows what is ready, what needs you and what is in progress', async () => {
  const repo = await getRepo();
  const mk = async (title: string, status: string, summary = '') => {
    const { item } = await repo.createItem({ sourceType: 'youtube', title, url: `https://www.youtube.com/watch?v=${title.replace(/\W/g, '').padEnd(11, 'x').slice(0, 11)}` });
    await repo.db.run('UPDATE items SET status = ?, summary = ? WHERE id = ?', [status, summary, item.id]);
  };
  await mk('Vector databases explained', 'READY', 'Vectors make search semantic. More text.');
  await mk('Reel without captions', 'NEEDS_INPUT');
  await mk('Still transcribing', 'TRANSCRIBING');
  wrap(<TodayScreen navigation={nav()} route={{ key: 't', name: 'Today' } as never} />);
  expect(await screen.findByText('Ready to review')).toBeTruthy();
  expect(screen.getByText('Vector databases explained')).toBeTruthy();
  expect(screen.getByText('Vectors make search semantic.')).toBeTruthy();
  expect(screen.getByText('Needs you')).toBeTruthy();
  expect(screen.getByText('Reel without captions')).toBeTruthy();
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByLabelText('2 in queue')).toBeTruthy(); // stat strip: 1 needs you + 1 in progress
});

test('ask can be scoped to one item and answers from it with timestamps', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Postgres indexing', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', languageMethod: 'provider', source: 'youtube_captions', provider: 'youtube-captions', segments: [
    { startMs: 0, endMs: 5000, text: 'Today: Postgres indexes.' },
    { startMs: 62000, endMs: 66000, text: 'Use a GIN index for JSONB documents.' },
  ] });
  const n = nav() as { navigate: jest.Mock };
  wrap(<AgentScreen navigation={n as never} route={{ key: 'a', name: 'Agent', params: { itemId: item.id } } as never} />);
  expect(await screen.findByText('Postgres indexing')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Ask the whole library instead' })).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Message'), 'Which index for JSONB?');
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  // The answer's [01:02] marker is a tappable "play from" pill that opens the video at that moment.
  fireEvent.press(await screen.findByLabelText('Play from 01:02', {}, { timeout: 3000 }));
  expect(n.navigate).toHaveBeenCalledWith('ItemDetail', { id: item.id, at: 62000 });
  const convs = await repo.listConversations();
  expect(convs[0].title).toBe('About: Postgres indexing');
});

test('the + sheet saves the copied link, and explains when there is none', async () => {
  const spy = jest.spyOn(Clipboard, 'getStringAsync');
  spy.mockResolvedValueOnce('look at this https://www.youtube.com/watch?v=dQw4w9WgXcQ !');
  const r = await captureCopiedLink();
  expect('itemId' in r && r.itemId).toBeTruthy();
  spy.mockResolvedValueOnce('just some words');
  expect(await captureCopiedLink()).toEqual({ message: 'The copied text has no link. Use “Note” to save text.' });
  const onCapture = jest.fn();
  wrap(<CaptureSheet visible onClose={jest.fn()} onOpenItem={jest.fn()} onCapture={onCapture} />);
  fireEvent.press(screen.getByRole('button', { name: 'Voice note' }));
  expect(onCapture).toHaveBeenCalledWith('voice');
});

test('daily digest text lists what is ready, else resurfaces something', () => {
  const [a, b, c] = ['A', 'B', 'C'].map((title) => ({ title, url: null }));
  expect(digestMessage([a, b, c], 5, null)).toEqual({ title: '5 ready to review', body: 'A · B · C and 2 more' });
  expect(digestMessage([], 0, { title: 'Old gem', url: null })).toEqual({ title: 'From your library', body: 'Revisit: Old gem' });
  expect(digestMessage([], 0, null).body).toMatch(/Nothing new/);
});

describe('library quick actions', () => {
  const act$ = (el: unknown, actionName: string) => fireEvent(el as never, 'accessibilityAction', { nativeEvent: { actionName } });

  async function seed() {
    const repo = await getRepo();
    const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Hooks deep dive', url: 'https://www.youtube.com/watch?v=abcdefghij1' });
    await repo.db.run("UPDATE items SET status = 'READY' WHERE id = ?", [item.id]);
    return { repo, id: item.id };
  }

  test('videos show as a 2-column grid by default and as cards in list view', async () => {
    await seed();
    wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
    const tile = await screen.findByLabelText('YouTube video: Hooks deep dive. Ready.');
    expect(tile.props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(['archive', 'favorite', 'collect', 'delete']);
    fireEvent.press(screen.getByRole('button', { name: 'List view' }));
    expect(await screen.findByLabelText(/^YouTube video: Hooks deep dive\. Ready\.$/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Grid view' })).toBeTruthy();
  });

  test('archive is immediate and can be undone', async () => {
    const { repo, id } = await seed();
    wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
    act$(await screen.findByLabelText(/Hooks deep dive/), 'archive');
    expect(await screen.findByText('Archived')).toBeTruthy();
    await waitFor(async () => expect((await repo.getItem(id))?.archived).toBe(true));
    fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await repo.getItem(id))?.archived).toBe(false));
  });

  test('delete hides the item, Undo keeps it, and leaving the screen commits it', async () => {
    const { repo, id } = await seed();
    const view = wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
    act$(await screen.findByLabelText(/Hooks deep dive/), 'delete');
    await waitFor(() => expect(screen.queryByLabelText(/Hooks deep dive/)).toBeNull());
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect((await repo.getItem(id))?.deleted).toBe(false); // nothing written yet
    fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByLabelText(/Hooks deep dive/)).toBeTruthy();

    act$(screen.getByLabelText(/Hooks deep dive/), 'delete');
    await waitFor(() => expect(screen.queryByLabelText(/Hooks deep dive/)).toBeNull());
    view.unmount();
    await waitFor(async () => expect(await repo.getItem(id)).toBeNull());
  });

  test('add one item to a collection from its row', async () => {
    const { repo, id } = await seed();
    const col = await repo.createCollection('Postgres');
    wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
    act$(await screen.findByLabelText(/Hooks deep dive/), 'collect');
    fireEvent.press(await screen.findByRole('button', { name: /^Postgres \(/ }));
    await waitFor(async () => expect(await repo.itemCollectionIds(id)).toEqual([col.id]));
    expect(await screen.findByText('Added to Postgres')).toBeTruthy();
  });
});
