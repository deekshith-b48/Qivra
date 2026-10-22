/**
 * Alternate server addresses. A server can advertise several URLs for itself
 * (home Wi-Fi LAN address, Tailscale/WireGuard address, MagicDNS name); when
 * the current one is unreachable the client tries the others in order. Only
 * network-level failures fail over — an auth error (revoked/unauthorized) is
 * the server's answer and is never retried elsewhere.
 */

import { ApiError } from './api';

const FAILOVER_KINDS = new Set(['offline', 'timeout', 'host_rejected', 'invalid_response', 'wrong_server', 'server']);

export function shouldFailOver(e: unknown): boolean {
  return !(e instanceof ApiError) || FAILOVER_KINDS.has(e.kind);
}

/** Primary first, then alternates, without duplicates or trailing slashes. */
export function orderedUrls(primary: string, alts: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const u of [primary, ...(alts ?? [])]) {
    const v = u.replace(/\/+$/, '');
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Run `attempt` against each URL until one succeeds. Rethrows the first URL's error if none do. */
export async function firstReachable<T>(urls: readonly string[], attempt: (url: string) => Promise<T>): Promise<{ url: string; value: T }> {
  let first: unknown = null;
  for (const [i, url] of urls.entries()) {
    try {
      return { url, value: await attempt(url) };
    } catch (e) {
      if (i === 0) first = e;
      if (!shouldFailOver(e)) throw e;
    }
  }
  throw first ?? new ApiError('offline', 'No server address to try.');
}
