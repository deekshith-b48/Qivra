import { aiInfo, loadProvider } from '../../src/services/ai';
import { getSecret } from '../../src/services/secure';
import { checkConnection, getConnection } from '../../src/services/server';
import { updateSettings } from '../../src/services/settings';
import { resetTestRepo } from '../helpers/uiSetup';

const GW = { enabled: true, upstream: 'api.groq.com', model: 'openai/gpt-oss-120b', embeddingModel: null, external: true };
const CONN = { serverUrl: 'http://192.168.1.2:5001/', serverId: 's', deviceId: 'd', aiGateway: GW };

jest.mock('../../src/services/server', () => ({ getConnection: jest.fn(), checkConnection: jest.fn() }));
jest.mock('../../src/services/secure', () => ({
  SECRET_KEYS: { deviceToken: 'qivra.device_token', aiApiKey: 'qivra.ai_api_key' },
  getSecret: jest.fn(async (k: string) => (k === 'qivra.device_token' ? 'qv1_device' : null)),
}));

const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: 'ok' } }] }), text: async () => '' }));

beforeEach(() => {
  resetTestRepo();
  jest.clearAllMocks();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

test('with no model on the phone, the paired server’s AI is used with the device credential only', async () => {
  jest.mocked(getConnection).mockResolvedValue(CONN as never);
  const info = await aiInfo();
  expect(info).toMatchObject({ enabled: true, source: 'server', model: 'openai/gpt-oss-120b', where: 'api.groq.com', autoEnrich: true });
  const { provider, source } = await loadProvider();
  expect(source).toBe('server');
  await provider!.chat([{ role: 'user', content: 'hi' }]);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
  expect(url).toBe('http://192.168.1.2:5001/api/v1/ai/chat/completions');
  expect(init.headers.Authorization).toBe('Bearer qv1_device');
  expect(getSecret).not.toHaveBeenCalledWith('qivra.ai_api_key');
});

test('a model configured on the phone takes precedence over the server', async () => {
  jest.mocked(getConnection).mockResolvedValue(CONN as never);
  await updateSettings({ ai: { enabled: true, baseUrl: 'http://192.168.1.10:11434/v1', model: 'qwen2.5:3b', embeddingModel: '', externalConsent: false, autoEnrich: false } });
  expect((await loadProvider()).source).toBe('phone');
  expect((await aiInfo()).source).toBe('phone');
});

test('older saved connections ask the server once; no gateway means no AI', async () => {
  jest.mocked(getConnection).mockResolvedValue({ ...CONN, aiGateway: undefined } as never);
  jest.mocked(checkConnection).mockResolvedValue({ ...CONN, aiGateway: null } as never);
  const state = await loadProvider();
  expect(checkConnection).toHaveBeenCalledTimes(1);
  expect(state.provider).toBeNull();
  expect((await aiInfo()).enabled).toBe(false);
});
