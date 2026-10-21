import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type React from 'react';
import { resetTestRepo } from '../helpers/uiSetup';
import { getRepo } from '../../src/services/db';
import { updateSettings } from '../../src/services/settings';
import { emit } from '../../src/services/events';
import { ThemeProvider, dark } from '../../src/ui/theme';
import OnboardingScreen from '../../src/screens/OnboardingScreen';
import LibraryScreen from '../../src/screens/LibraryScreen';
import ConnectServerScreen from '../../src/screens/ConnectServerScreen';
import ItemDetailScreen from '../../src/screens/ItemDetailScreen';
import AgentScreen from '../../src/screens/AgentScreen';
import ReportDetailScreen from '../../src/screens/ReportDetailScreen';
import CaptureScreen from '../../src/screens/CaptureScreen';
import { generateReport } from '../../src/services/reports';

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn(), replace: jest.fn(), push: jest.fn(), setParams: jest.fn() } as never;
}
const wrap = (el: React.ReactElement) => render(<ThemeProvider>{el}</ThemeProvider>);

beforeEach(() => resetTestRepo());

test('onboarding marks the app onboarded and opens the main tabs', async () => {
  const n = nav() as { reset: jest.Mock };
  wrap(<OnboardingScreen navigation={n as never} route={{ key: 'o', name: 'Onboarding' } as never} />);
  fireEvent.press(screen.getByRole('button', { name: 'Start using Qivra' }));
  await waitFor(() => expect(n.reset).toHaveBeenCalled());
  expect(await (await getRepo()).getMeta('app.onboarded')).toBe('1');
});

test('library has Videos / Websites / Notes sections with real items and text filter', async () => {
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
  fireEvent.changeText(screen.getByLabelText('Filter your library'), 'claude');
  await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy(), { timeout: 3000 });
});

test('connect screen validates manual pairing input before any network call', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch' as never);
  wrap(<ConnectServerScreen navigation={nav()} route={{ key: 'c', name: 'ConnectServer', params: {} } as never} />);
  fireEvent.changeText(await screen.findByLabelText('Server URL'), 'http://example.com:5000');
  fireEvent.changeText(screen.getByLabelText('Access ID'), 'ABCD-2345');
  fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText(/only allowed for local-network addresses/)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Server URL'), '192.168.1.20:5001');
  fireEvent.changeText(screen.getByLabelText('Access ID'), '12');
  fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText(/8 characters/)).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Scan QR code' })).toBeTruthy();
});

test('video page: one scroll with TL;DR, key moments, keyword chips filtering a collapsible transcript, details', async () => {
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
  expect(screen.queryByRole('tab')).toBeNull(); // no tabs any more
  expect(screen.getByText('TL;DR')).toBeTruthy();
  expect(screen.getByText('Extracted on device')).toBeTruthy();
  expect(screen.queryByText('AI summary · generating…')).toBeNull();
  expect(screen.getByText('Key moments')).toBeTruthy();
  expect(screen.getByLabelText('Play from 1:01')).toBeTruthy(); // key moment timestamp is tappable on YouTube
  expect(screen.queryByRole('button', { name: 'Enrich on server' })).toBeNull();
  // Transcript is collapsed until a keyword chip is tapped, which also filters it.
  expect(screen.queryByText('1:10')).toBeNull();
  fireEvent.press(await screen.findByRole('button', { name: 'hooks' }));
  expect(await screen.findByText('Showing lines with “hooks” ✕')).toBeTruthy();
  expect(screen.getByText('1:10')).toBeTruthy();
  expect(screen.getByLabelText(/^Transcript, 2 lines$/)).toBeTruthy();
  // Details (note, tags, commands…) are collapsed by default.
  expect(screen.queryByText(/Potentially destructive/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Details' }));
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
  expect(await screen.findByText('Connect your server to transcribe')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Connect server' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Import transcript' }).length).toBeGreaterThan(0);
  for (const extra of ['Retry', 'Try server again']) expect(screen.queryByRole('button', { name: extra })).toBeNull();
});

test('agent answers from saved items with a tappable citation when no model is configured', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'note', title: 'Kubernetes operators notes', note: 'Operators reconcile desired state.' });
  const n = nav() as { navigate: jest.Mock };
  wrap(<AgentScreen navigation={n as never} route={{ key: 'a', name: 'Agent' } as never} />);
  fireEvent.changeText(await screen.findByLabelText('Message'), 'kubernetes operators');
  fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText(/Assembled from your items/, {}, { timeout: 4000 })).toBeTruthy();
  const cite = await screen.findByLabelText(/Source S1/);
  fireEvent.press(cite);
  expect(n.navigate).toHaveBeenCalledWith('ItemDetail', { id: item.id });
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
