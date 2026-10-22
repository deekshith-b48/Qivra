import { getRepo } from '../../src/services/db';
import { setSecret, SECRET_KEYS } from '../../src/services/secure';
import { checkConnection, getConnection, probeServer } from '../../src/services/server';
import { resetTestRepo } from '../helpers/uiSetup';

const HOME = 'http://192.168.1.20:5001';
const TAILNET = 'http://mac.tail1234.ts.net:5001';
const STATUS = { paired: true, device: { id: 'd' }, server: { id: 'abcdef12', version: '1.7', lan_enabled: true }, server_time: '2026-10-22T10:00:00Z', ai: { available: false, providers: {} } };
const HEALTH = { product: 'Qivra', status: 'ok', server_id: 'abcdef12', version: '1.7', time: new Date().toISOString() };

/** Only the Tailscale address answers: the phone is away from home Wi-Fi. */
const fetchMock = jest.fn(async (url: string) => {
  if (url.startsWith(HOME)) throw new TypeError('Network request failed');
  return { ok: true, status: 200, json: async () => (url.endsWith('/api/health') ? HEALTH : STATUS) };
});

const CONN = {
  serverUrl: HOME, altUrls: [TAILNET], serverId: 'abcdef12', deviceId: 'd', deviceName: 'Pixel', pairedAt: '2026-10-01T00:00:00Z', cleartext: true,
  lastHealthAt: null, lastError: null, serverVersion: null, lanEnabled: true, aiAvailable: null,
};

beforeEach(async () => {
  resetTestRepo();
  fetchMock.mockClear();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  await setSecret(SECRET_KEYS.deviceToken, 'qv1_device');
});

test('checkConnection falls back to an alternate URL and makes it current', async () => {
  await (await getRepo()).setJson('server.connection', CONN);
  const c = await checkConnection();
  expect(c).toMatchObject({ serverUrl: TAILNET, altUrls: [HOME], lastError: null, serverVersion: '1.7' });
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([`${HOME}/api/v1/pairing/status`, `${TAILNET}/api/v1/pairing/status`]);
  expect(await getConnection()).toMatchObject({ serverUrl: TAILNET });
});

test('without alternates a failure is recorded as before', async () => {
  await (await getRepo()).setJson('server.connection', { ...CONN, altUrls: undefined });
  const c = await checkConnection();
  expect(c).toMatchObject({ serverUrl: HOME, lastError: { kind: 'offline' } });
});

test('probeServer tries the QR alternates and pairs with the address that answered', async () => {
  const r = await probeServer({ version: 1, product: 'Qivra', serverUrl: HOME, altUrls: [TAILNET], serverId: 'abcdef12', pairingId: 'CCWW5HVZ', expiresAt: null, cleartext: true });
  expect(r.payload).toMatchObject({ serverUrl: TAILNET, altUrls: [HOME] });
});
