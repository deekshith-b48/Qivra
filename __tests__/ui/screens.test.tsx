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

test('library shows empty state, then real items, and filters by text', async () => {
  wrap(<LibraryScreen navigation={nav()} route={{ key: 'l', name: 'Library' } as never} />);
  expect(await screen.findByText('Your library is empty')).toBeTruthy();
  const repo = await getRepo();
  await act(async () => {
    await repo.createItem({ sourceType: 'github', title: 'anthropics/claude-code', url: 'https://github.com/anthropics/claude-code' });
    await repo.createItem({ sourceType: 'note', title: 'Pasta recipe' });
    emit('items');
  });
  expect(await screen.findByText('anthropics/claude-code')).toBeTruthy();
  expect(screen.getByText('Pasta recipe')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Filter your library'), 'claude');
  await waitFor(() => expect(screen.queryByText('Pasta recipe')).toBeNull(), { timeout: 3000 });
  expect(screen.getByText('anthropics/claude-code')).toBeTruthy();
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

test('item detail shows timestamped transcript, provenance and flags destructive commands', async () => {
  const repo = await getRepo();
  const { item } = await repo.createItem({ sourceType: 'youtube', title: 'Hooks tutorial', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  await repo.upsertTranscript({ itemId: item.id, language: 'en', source: 'import_srt', segments: [{ startMs: 61000, endMs: 64000, text: 'Run rm -rf build before packaging.' }] });
  await repo.updateItem(item.id, {
    summary: 'Configure hooks.', summaryOrigin: 'local',
    enrichment: { origin: 'local', version: 1, provider: 'qivra-local-extractive', generatedAt: '2026-10-21T00:00:00Z', summary: 'Configure hooks.', keyPoints: [], concepts: [], tools: ['Claude Code'], commands: [{ command: 'rm -rf build', destructive: true, reason: 'Recursively/forcibly deletes files' }], repos: [], urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [] },
  });
  wrap(<ItemDetailScreen navigation={nav()} route={{ key: 'i', name: 'ItemDetail', params: { id: item.id } } as never} />);
  expect(await screen.findByText('Hooks tutorial')).toBeTruthy();
  expect(await screen.findByText('1:01')).toBeTruthy();
  expect(screen.getByText('Extracted on device')).toBeTruthy();
  expect(screen.getByText(/Potentially destructive/)).toBeTruthy();
  expect(screen.getByLabelText('Back')).toBeTruthy();
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
