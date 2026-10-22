import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import DevScreen from '../../src/screens/DevScreen';
import OnboardingScreen from '../../src/screens/OnboardingScreen';
import { getRepo } from '../../src/services/db';
import { getSettings } from '../../src/services/settings';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

function nav() {
  return { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn(), setOptions: jest.fn(), isFocused: () => true } as never;
}
const wrap = (el: React.ReactElement) => render(<ThemeProvider>{el}</ThemeProvider>);

const GH = { items: [{ full_name: 'DietrichGebert/ponytail', html_url: 'https://github.com/DietrichGebert/ponytail', description: 'Lazy senior dev mode', stargazers_count: 4200 }] };
const HN = { hits: [{ objectID: '42', title: 'AI agents find bugs', url: 'https://example.com/ai', points: 300, num_comments: 80 }] };
const HF = [{ id: 'deepseek-ai/DeepSeek-V4', likes: 2300, pipeline_tag: 'text-generation' }];

beforeEach(() => {
  resetTestRepo();
  global.fetch = jest.fn(async (url: string) => {
    const body = url.includes('hn.algolia') ? HN : url.includes('huggingface') ? HF : GH;
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
