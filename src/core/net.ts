/**
 * Network policy for the app's single HTTP layer.
 *
 * Android's network-security-config cannot express "cleartext only to private
 * IP ranges", so cleartext is permitted at the platform level and enforced
 * here instead: plain http:// is allowed only to loopback, RFC1918, link-local,
 * CGNAT (Tailscale-style VPN), Tailscale MagicDNS (*.ts.net) and *.local hosts.
 * Everything else must be https.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function parseIpv4(host: string): number[] | null {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** `mac.tail1234.ts.net`: resolves only inside the user's own tailnet (MagicDNS). */
export function isTailnetName(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  return host.endsWith('.ts.net') && host.split('.').length >= 3;
}

function isCgnat(v4: number[]): boolean {
  return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
}

export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || isTailnetName(host)) return true;
  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      isCgnat(v4)
    );
  }
  if (host.includes(':')) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

export type UrlCheck =
  | { ok: true; url: URL; cleartext: boolean }
  | { ok: false; code: 'INVALID_URL' | 'UNSUPPORTED_SCHEME' | 'CLEARTEXT_PUBLIC_HOST' | 'HAS_CREDENTIALS' | 'BAD_PORT'; message: string };

/** Validate a server base URL (from QR or manual entry). */
export function checkServerUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'Enter a full URL such as http://192.168.1.20:5000' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'UNSUPPORTED_SCHEME', message: 'Only http:// and https:// server addresses are supported.' };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'HAS_CREDENTIALS', message: 'Server URLs must not contain a username or password.' };
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) {
    return { ok: false, code: 'BAD_PORT', message: 'Port must be between 1 and 65535.' };
  }
  const cleartext = url.protocol === 'http:';
  if (cleartext && !isPrivateHost(url.hostname)) {
    return {
      ok: false,
      code: 'CLEARTEXT_PUBLIC_HOST',
      message: 'Plain http:// is only allowed for local-network addresses. Use https:// for anything else.',
    };
  }
  return { ok: true, url, cleartext };
}

/** Canonical base URL: scheme://host[:port] with no path, query or trailing slash. */
export function baseUrlOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * True for a private VPN address (Tailscale/WireGuard: 100.64/10 or *.ts.net),
 * which keeps working when the phone is away from home Wi-Fi.
 */
export function isPrivateNetworkUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const v4 = parseIpv4(host);
  return v4 ? isCgnat(v4) : isTailnetName(host);
}
