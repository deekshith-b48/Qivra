/**
 * Pairing QR payload validation. The app never trusts QR content: it must be
 * a version-1 Qivra payload with a well-formed local/https server URL, a
 * pairing code in the expected alphabet, and an expiry that has not passed.
 * The optional `alt_urls` (e.g. a Tailscale address) is additive, so it needs
 * no version bump; each entry is validated like `server_url` and invalid ones are dropped.
 */

import { baseUrlOf, checkServerUrl } from './net';

export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_QR_LENGTH = 1024;
export const MAX_ALT_URLS = 4;
/** Tolerated clock skew between phone and laptop when checking expiry locally. */
export const CLOCK_SKEW_MS = 2 * 60_000;

export interface PairingPayload {
  version: 1;
  product: 'Qivra';
  serverUrl: string;
  /** Other addresses of the same server, tried when `serverUrl` is unreachable. */
  altUrls: string[];
  serverId: string | null;
  pairingId: string;
  expiresAt: string | null;
  cleartext: boolean;
}

export type QrError =
  | 'NOT_JSON'
  | 'TOO_LARGE'
  | 'WRONG_PRODUCT'
  | 'UNSUPPORTED_VERSION'
  | 'BAD_SERVER_URL'
  | 'CLEARTEXT_PUBLIC_HOST'
  | 'BAD_PAIRING_ID'
  | 'BAD_SERVER_ID'
  | 'BAD_EXPIRY'
  | 'EXPIRED'
  | 'LEGACY_SUPERBRAIN';

export const QR_ERROR_MESSAGES: Record<QrError, string> = {
  NOT_JSON: 'This QR code is not a Qivra pairing code.',
  TOO_LARGE: 'This QR code is too large to be a Qivra pairing code.',
  WRONG_PRODUCT: 'This QR code is not a Qivra pairing code.',
  UNSUPPORTED_VERSION: 'This pairing code needs a newer version of Qivra.',
  BAD_SERVER_URL: 'The server address in this QR code is invalid.',
  CLEARTEXT_PUBLIC_HOST: 'Refusing an unencrypted (http) connection to a public internet address.',
  BAD_PAIRING_ID: 'The access ID in this QR code is malformed.',
  BAD_SERVER_ID: 'The server identifier in this QR code is malformed.',
  BAD_EXPIRY: 'The expiry time in this QR code is invalid.',
  EXPIRED: 'This pairing code has expired. Press Enter in the server terminal (or run `python -m qivra pair`) for a new one.',
  LEGACY_SUPERBRAIN:
    'This is an old SuperBrain QR code containing a permanent token. Qivra does not accept it — start the server with `python -m qivra serve` and scan the new one-time code.',
};

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-_]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function isValidPairingCode(code: string): boolean {
  return code.length === 8 && [...code].every((c) => PAIRING_ALPHABET.includes(c));
}

export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function parsePairingQr(raw: string, nowMs: number): { ok: true; payload: PairingPayload } | { ok: false; error: QrError } {
  if (raw.length > MAX_QR_LENGTH) return { ok: false, error: 'TOO_LARGE' };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'NOT_JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'NOT_JSON' };
  const o = obj as Record<string, unknown>;
  if (typeof o.token === 'string' && typeof o.url === 'string' && o.product === undefined) {
    return { ok: false, error: 'LEGACY_SUPERBRAIN' };
  }
  if (o.product !== 'Qivra') return { ok: false, error: 'WRONG_PRODUCT' };
  if (o.version !== 1) return { ok: false, error: 'UNSUPPORTED_VERSION' };
  if (typeof o.server_url !== 'string') return { ok: false, error: 'BAD_SERVER_URL' };
  const check = checkServerUrl(o.server_url);
  if (!check.ok) return { ok: false, error: check.code === 'CLEARTEXT_PUBLIC_HOST' ? 'CLEARTEXT_PUBLIC_HOST' : 'BAD_SERVER_URL' };
  if (check.url.pathname !== '/' || check.url.search || check.url.hash) return { ok: false, error: 'BAD_SERVER_URL' };
  const code = typeof o.pairing_id === 'string' ? normalizePairingCode(o.pairing_id) : '';
  if (!isValidPairingCode(code)) return { ok: false, error: 'BAD_PAIRING_ID' };
  let serverId: string | null = null;
  if (o.server_id !== undefined) {
    if (typeof o.server_id !== 'string' || !/^[a-f0-9]{8,40}$/.test(o.server_id)) return { ok: false, error: 'BAD_SERVER_ID' };
    serverId = o.server_id;
  }
  let expiresAt: string | null = null;
  if (o.expires_at !== undefined) {
    const t = typeof o.expires_at === 'string' ? Date.parse(o.expires_at) : Number.NaN;
    if (!Number.isFinite(t)) return { ok: false, error: 'BAD_EXPIRY' };
    if (t + CLOCK_SKEW_MS < nowMs) return { ok: false, error: 'EXPIRED' };
    expiresAt = new Date(t).toISOString();
  }
  const serverUrl = baseUrlOf(check.url);
  return {
    ok: true,
    payload: {
      version: 1,
      product: 'Qivra',
      serverUrl,
      altUrls: parseAltUrls(o.alt_urls, serverUrl),
      serverId,
      pairingId: code,
      expiresAt,
      cleartext: check.cleartext,
    },
  };
}

function parseAltUrls(raw: unknown, primary: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const u of raw) {
    if (typeof u !== 'string') continue;
    const c = checkServerUrl(u);
    if (!c.ok || c.url.pathname !== '/' || c.url.search || c.url.hash) continue;
    const base = baseUrlOf(c.url);
    if (base !== primary && !out.includes(base)) out.push(base);
    if (out.length >= MAX_ALT_URLS) break;
  }
  return out;
}

/** Build a payload from manual entry (server URL + access ID). */
export function manualPairing(serverUrl: string, accessId: string):
  | { ok: true; payload: PairingPayload }
  | { ok: false; field: 'url' | 'code'; message: string } {
  const check = checkServerUrl(serverUrl.includes('://') ? serverUrl : `http://${serverUrl}`);
  if (!check.ok) return { ok: false, field: 'url', message: check.message };
  const code = normalizePairingCode(accessId);
  if (!isValidPairingCode(code)) {
    return { ok: false, field: 'code', message: 'The access ID has 8 characters, like 7K3M-9XPA.' };
  }
  return {
    ok: true,
    payload: { version: 1, product: 'Qivra', serverUrl: baseUrlOf(check.url), altUrls: [], serverId: null, pairingId: code, expiresAt: null, cleartext: check.cleartext },
  };
}
