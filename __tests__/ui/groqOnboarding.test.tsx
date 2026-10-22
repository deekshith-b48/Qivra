import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OnboardingScreen from '../../src/screens/OnboardingScreen';
import { deleteSecret, getSecret, SECRET_KEYS } from '../../src/services/secure';
import { getSettings } from '../../src/services/settings';
import { ThemeProvider } from '../../src/ui/theme';
import { resetTestRepo } from '../helpers/uiSetup';

const nav = () => ({ navigate: jest.fn(), reset: jest.fn() }) as never;
const wrap = () => render(<ThemeProvider><OnboardingScreen navigation={nav()} route={{ key: 'o', name: 'Onboarding' } as never} /></ThemeProvider>);
const answer = (status: number, body: unknown) => jest.fn(async () => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) }));

beforeEach(async () => {
  resetTestRepo();
  await deleteSecret(SECRET_KEYS.aiApiKey);
});

test('a working Groq key is verified, stored securely and turns AI on', async () => {
  global.fetch = answer(200, { model: 'openai/gpt-oss-120b', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) as never;
  wrap();
  fireEvent.changeText(screen.getByLabelText('Your Groq API key'), 'gsk_test_valid_key');
  fireEvent.press(screen.getByRole('button', { name: 'Verify & save' }));
  await waitFor(async () => expect(await getSecret(SECRET_KEYS.aiApiKey)).toBe('gsk_test_valid_key'));
  expect((await getSettings()).ai).toMatchObject({ enabled: true, baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', externalConsent: true });
  const [url, init] = jest.mocked(global.fetch).mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
  expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
  expect(init.headers.Authorization).toBe('Bearer gsk_test_valid_key');
});

test('a rejected key shows an error and is not stored; Later skips AI', async () => {
  global.fetch = answer(401, { error: { message: 'Invalid API Key' } }) as never;
  wrap();
  fireEvent.changeText(screen.getByLabelText('Your Groq API key'), 'gsk_wrong');
  fireEvent.press(screen.getByRole('button', { name: 'Verify & save' }));
  expect(await screen.findByText(/Groq rejected this key/)).toBeTruthy();
  expect(await getSecret(SECRET_KEYS.aiApiKey)).toBeNull();
  expect((await getSettings()).ai.enabled).toBe(false);
});
