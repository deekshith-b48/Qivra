/**
 * "Connect to My Server": pairing, health checks, disconnect/revoke.
 * The device credential lives only in Keystore-backed storage; the
 * non-secret connection details (URL, server id, device id) live in the DB.
 */

import { type AiGatewayInfo, ApiError, QivraClient, type Health } from '../core/api';
import { firstReachable, orderedUrls } from '../core/failover';
import type { PairingPayload } from '../core/qr';
import { CLOCK_SKEW_MS } from '../core/qr';
import { disableSync, enableSync } from '../sync/engine';
import { getRepo } from './db';
import { emit } from './events';
import { deleteSecret, getSecret, SECRET_KEYS, setSecret } from './secure';

export interface Connection {
  serverUrl: string;
  /** Other addresses of the same server (e.g. Tailscale), tried when `serverUrl` fails. Undefined on older connections. */
  altUrls?: string[];
  serverId: string;
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  cleartext: boolean;
  lastHealthAt: string | null;
  lastError: { kind: string; message: string; at: string } | null;
  serverVersion: string | null;
  lanEnabled: boolean | null;
  aiAvailable: boolean | null;
  /** Undefined on connections saved before the server offered an AI gateway. */
  aiGateway?: AiGateway | null;
}

export interface AiGateway {
  enabled: boolean;
  upstream: string | null;
  model: string | null;
  embeddingModel: string | null;
  external: boolean;
}

function gatewayOf(g: AiGatewayInfo | undefined): AiGateway | null {
  if (!g?.enabled || !g.model) return null;
  return { enabled: true, upstream: g.upstream ?? null, model: g.model, embeddingModel: g.embedding_model ?? null, external: g.external ?? true };
}

const KEY = 'server.connection';

export async function getConnection(): Promise<Connection | null> {
  const repo = await getRepo();
  return repo.getJson<Connection | null>(KEY, null);
}

async function saveConnection(c: Connection | null): Promise<void> {
  const repo = await getRepo();
  if (c) await repo.setJson(KEY, c);
  else await repo.setMeta(KEY, 'null');
  emit('connection');
}

export async function getClient(): Promise<QivraClient | null> {
  const c = await getConnection();
  if (!c) return null;
  const token = await getSecret(SECRET_KEYS.deviceToken);
  if (!token) return null;
  return new QivraClient({ baseUrl: c.serverUrl, token });
}

export type PairStep = 'checking' | 'pairing' | 'verifying' | 'done';

/**
 * Step 1 (before confirmation): reach the server and check it is the one in the QR.
 * Tries the QR's alternate addresses when the primary is unreachable; the returned
 * payload has the address that answered as `serverUrl`.
 */
export async function probeServer(payload: PairingPayload): Promise<{ health: Health; clockSkewMs: number; payload: PairingPayload }> {
  const urls = orderedUrls(payload.serverUrl, payload.altUrls);
  const { url, value: health } = await firstReachable(urls, async (baseUrl) => {
    const anon = new QivraClient({ baseUrl, retries: urls.length > 1 ? 0 : 1 });
    const h = await anon.health(6000);
    if (payload.serverId && h.server_id !== payload.serverId) {
      throw new ApiError('wrong_server', 'This address answered, but it is a different Qivra server than the QR code describes.');
    }
    return h;
  });
  const skew = Date.parse(health.time) - Date.now();
  if (payload.expiresAt && Date.parse(payload.expiresAt) + CLOCK_SKEW_MS < Date.parse(health.time)) {
    // Expiry is judged by the server's clock, so a wrong phone clock can't block or extend pairing.
    throw new ApiError('pairing', 'This pairing code has expired. Generate a new one on the server.', 410, 'PAIRING_EXPIRED');
  }
  return { health, clockSkewMs: skew, payload: { ...payload, serverUrl: url, altUrls: urls.filter((u) => u !== url) } };
}

/** Steps 2–3: exchange the one-time code for a device credential, then verify it. */
export async function completePairing(payload: PairingPayload, deviceName: string, onStep?: (s: PairStep) => void): Promise<Connection> {
  onStep?.('pairing');
  const anon = new QivraClient({ baseUrl: payload.serverUrl, retries: 0 });
  const res = await anon.completePairing(payload.pairingId, deviceName.trim().slice(0, 60) || 'Android device', payload.serverId);
  await setSecret(SECRET_KEYS.deviceToken, res.device_token);
  onStep?.('verifying');
  const authed = new QivraClient({ baseUrl: payload.serverUrl, token: res.device_token });
  try {
    const status = await authed.pairingStatus();
    const conn: Connection = {
      serverUrl: payload.serverUrl, altUrls: payload.altUrls ?? [], serverId: res.server_id, deviceId: res.device.id, deviceName: res.device.name, pairedAt: new Date().toISOString(),
      cleartext: payload.cleartext, lastHealthAt: new Date().toISOString(), lastError: null, serverVersion: status.server.version,
      lanEnabled: status.server.lan_enabled, aiAvailable: status.ai?.available ?? null, aiGateway: gatewayOf(status.ai_gateway),
    };
    await saveConnection(conn);
    const repo = await getRepo();
    await repo.setMeta('sync.cursor', '0');
    await enableSync(repo);
    onStep?.('done');
    return conn;
  } catch (e) {
    // The credential could not be verified: don't keep a half-paired state.
    await authed.revokeDevice(res.device.id).catch(() => undefined);
    await deleteSecret(SECRET_KEYS.deviceToken);
    throw e;
  }
}

/**
 * Authenticated health check. Updates "last successful check" only on success.
 * If the current address is unreachable (e.g. away from home Wi-Fi), the saved
 * alternates are tried and the first that answers becomes the current address.
 */
export async function checkConnection(): Promise<Connection | null> {
  const c = await getConnection();
  if (!c) return null;
  const token = await getSecret(SECRET_KEYS.deviceToken);
  if (!token) {
    await saveConnection({ ...c, lastError: { kind: 'unauthorized', message: 'The saved device credential is missing. Pair again.', at: new Date().toISOString() } });
    return getConnection();
  }
  const urls = orderedUrls(c.serverUrl, c.altUrls);
  try {
    const { url, value: status } = await firstReachable(urls, async (baseUrl) => {
      // With alternates, fail over quickly instead of retrying a network the phone has left.
      const client = new QivraClient(urls.length > 1 ? { baseUrl, token, retries: 0, timeoutMs: 6000 } : { baseUrl, token });
      const st = await client.pairingStatus();
      if (st.server.id !== c.serverId) throw new ApiError('wrong_server', 'A different Qivra server is now answering at this address.');
      return st;
    });
    await saveConnection({ ...c, serverUrl: url, cleartext: url.startsWith('http:'), altUrls: urls.filter((u) => u !== url), lastHealthAt: new Date().toISOString(), lastError: null, serverVersion: status.server.version, lanEnabled: status.server.lan_enabled, aiAvailable: status.ai?.available ?? null, aiGateway: gatewayOf(status.ai_gateway) });
  } catch (e) {
    const err = e instanceof ApiError ? e : new ApiError('offline', String(e));
    await saveConnection({ ...c, lastError: { kind: err.kind, message: err.message, at: new Date().toISOString() } });
  }
  return getConnection();
}

/** Disconnect locally; when `revoke`, also ask the server to revoke this device's credential. */
export async function disconnect(revoke: boolean): Promise<{ revokedOnServer: boolean }> {
  const c = await getConnection();
  let revokedOnServer = false;
  if (c && revoke) {
    const client = await getClient();
    try {
      await client?.revokeDevice(c.deviceId);
      revokedOnServer = true;
    } catch {
      revokedOnServer = false;
    }
  }
  await deleteSecret(SECRET_KEYS.deviceToken);
  await saveConnection(null);
  const repo = await getRepo();
  await disableSync(repo);
  await repo.db.run(`UPDATE items SET sync_status = 'local_only', server_revision = NULL WHERE sync_status != 'conflicted'`);
  await repo.db.run(`UPDATE collections SET sync_status = 'local_only', server_revision = NULL`);
  await repo.setMeta('sync.cursor', '0');
  emit('items', 'collections');
  return { revokedOnServer };
}
