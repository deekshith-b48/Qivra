import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import DevScreen from '../../src/screens/DevScreen';
import OnboardingScreen from '../../src/screens/OnboardingScreen';
import { getRepo } from '../../src/services/db';
import { getSettings, updateSettings } from '../../src/services/settings';
import { localDate } from '../../src/core/dates';
import { prevDay } from '../../src/core/devFeeds';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn(), setOptions: jest.fn(), isFocused: () => true } as never;
}
const wrap = (el: React.ReactElement) => render(<ThemeProvider>{el}</ThemeProvider>);

const GH = { items: [{ full_name: 'DietrichGebert/ponytail', html_url: 'https://github.com/DietrichGebert/ponytail', description: 'Lazy senior dev mode', stargazers_count: 4200 }] };
const HN = { hits: [{ objectID: '42', title: 'AI agents find bugs', url: 'https://example.com/ai', points: 300, num_comments: 80 }] };
const RELEASES = [{ tag_name: 'v2.1.0', html_url: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.0', published_at: new Date().toISOString(), body: 'Faster startup' }];
const HF = [{ id: 'deepseek-ai/DeepSeek-V4', likes: 2300, pipeline_tag: 'text-generation' }];

beforeEach(() => {
  resetTestRepo();
  global.fetch = jest.fn(async (url: string) => {
    const body = url.includes('/releases') ? RELEASES : url.includes('hn.algolia') ? HN : url.includes('huggingface') ? HF : GH;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  }) as never;
});

test('onboarding asks about Dev mode: "Turn on" enables it, "Not now" leaves it off', async () => {
  wrap(<OnboardingScreen navigation={nav()} route={{ key: 'o', name: 'Onboarding' } as never} />);
  expect(screen.getByText('Are you a developer?')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
  await waitFor(async () => expect((await getSettings()).devMode).toBe(false));
  fireEvent.press(screen.getByRole('button', { name: 'Turn on Dev Mode' }));
  await waitFor(async () => expect((await getSettings()).devMode).toBe(true));
  expect(await screen.findByLabelText('Page 6 of 7')).toBeTruthy(); // on to the Groq key page
});

test('Dev screen: habits, trends from all three sources, save to library, copy a plugin install command', async () => {
  const copied = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  wrap(<DevScreen navigation={nav()} route={{ key: 'd', name: 'Dev' } as never} />);
  expect(await screen.findByText('Daily habits')).toBeTruthy();
  // Opening the tab ticks "Check the trends".
  expect(await screen.findByLabelText('Check the trends: done')).toBeTruthy();
  fireEvent.press(screen.getByRole('tab', { name: 'Trends' }));
  expect(await screen.findByText('AI agents find bugs')).toBeTruthy();
  expect(screen.getByText('deepseek-ai/DeepSeek-V4')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Save AI agents find bugs to Qivra' }));
  await waitFor(async () => expect((await (await getRepo()).listItems({ sourceTypes: ['web'] })).map((i) => i.url)).toEqual(['https://example.com/ai']));
  fireEvent.press(screen.getByRole('tab', { name: 'Claude' }));
  fireEvent.press((await screen.findAllByRole('button', { name: 'Copy install command for DietrichGebert/ponytail' }))[0]);
  expect(copied).toHaveBeenCalledWith('/plugin marketplace add DietrichGebert/ponytail');
});

test('Dev upgrades: repo releases, heatmap + weekly report, Claude "new this week" + library mark, toolbox filter and groups', async () => {
  const navigation = nav() as unknown as { navigate: jest.Mock };
  const repo = await getRepo();
  const { timezone } = await getSettings();
  const today = localDate(Date.now(), timezone);
  await repo.setMeta(`dev.day.${prevDay(today)}`, '1');
  await repo.setMeta(`dev.day.${prevDay(prevDay(today))}`, '1');
  await updateSettings({ devFollows: ['anthropics/claude-code'] });
  const enr = { origin: 'local', version: 1, provider: 't', generatedAt: '2026-10-01T00:00:00Z', summary: '', keyPoints: [], concepts: [], tools: ['Docker'], urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [],
    repos: ['dietrichgebert/ponytail'], // lower case: the library mark ignores case
    commands: [{ command: 'git status', destructive: false }, { command: 'git log --oneline', destructive: false }, { command: 'npx expo prebuild', destructive: false }] };
  const { item } = await repo.createItem({ sourceType: 'github', url: 'https://github.com/DietrichGebert/ponytail', title: 'ponytail' });
  await repo.updateItem(item.id, { enrichment: enr as never });

  wrap(<DevScreen navigation={navigation as never} route={{ key: 'd', name: 'Dev' } as never} />);
  // Follow-ups: the followed repo's new release, by tag.
  expect(await screen.findByText('anthropics/claude-code v2.1.0')).toBeTruthy();
  // Heatmap and best streak from the two completed days.
  expect(await screen.findByLabelText('2 active days in the last 5 weeks')).toBeTruthy();
  expect(screen.getByText(/best streak 2 days/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Weekly report' }));
  await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('ReportDetail', expect.objectContaining({ id: expect.any(String) })));

  // Claude: "New this week" asks GitHub for recently created repos; a repo in the library is marked.
  fireEvent.press(screen.getByRole('tab', { name: 'Claude' }));
  expect((await screen.findAllByText('In your library')).length).toBeGreaterThan(0);
  fireEvent.press(screen.getByRole('tab', { name: 'New this week' }));
  await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.some(([u]) => String(u).includes('created%3A%3E'))).toBe(true));

  // Toolbox: commands grouped by tool; the filter narrows the lists.
  fireEvent.press(screen.getByRole('tab', { name: 'Toolbox' }));
  expect(await screen.findByText('git · 2')).toBeTruthy();
  expect(screen.getByText('expo · 1')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Filter'), 'expo');
  expect(await screen.findByText('npx expo prebuild')).toBeTruthy();
  expect(screen.queryByText('git status')).toBeNull();
  expect(screen.queryByText('dietrichgebert/ponytail')).toBeNull();
});
