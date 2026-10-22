import { ApiError } from '../../src/core/api';
import { firstReachable, orderedUrls, shouldFailOver } from '../../src/core/failover';
import { checkServerUrl, isPrivateHost, isPrivateNetworkUrl, isTailnetName } from '../../src/core/net';
import { MAX_ALT_URLS, parsePairingQr } from '../../src/core/qr';

describe('private VPN hosts', () => {
  test('Tailscale MagicDNS names are private', () => {
    expect(isPrivateHost('x.tail1234.ts.net')).toBe(true);
    expect(isPrivateHost('MacBook.Tail1234.TS.NET')).toBe(true);
    expect(isTailnetName('mac.tail1234.ts.net.')).toBe(true);
    expect(checkServerUrl('http://mac.tail1234.ts.net:5001')).toMatchObject({ ok: true, cleartext: true });
  });

  test('look-alikes stay public', () => {
    expect(isPrivateHost('ts.net')).toBe(false);
    expect(isPrivateHost('evil-ts.net')).toBe(false);
    expect(isPrivateHost('x.ts.net.evil.com')).toBe(false);
    expect(checkServerUrl('http://x.ts.net.evil.com')).toMatchObject({ ok: false, code: 'CLEARTEXT_PUBLIC_HOST' });
  });

  test('"works away from home" detection', () => {
    expect(isPrivateNetworkUrl('http://100.101.102.103:5001')).toBe(true);
    expect(isPrivateNetworkUrl('http://mac.tail1234.ts.net:5001')).toBe(true);
    expect(isPrivateNetworkUrl('http://192.168.1.20:5001')).toBe(false);
    expect(isPrivateNetworkUrl('http://100.128.0.1:5001')).toBe(false);
    expect(isPrivateNetworkUrl('not a url')).toBe(false);
  });
});

describe('QR alt_urls', () => {
  const now = Date.parse('2026-10-20T20:31:00Z');
  const base = { version: 1, product: 'Qivra', server_url: 'http://192.168.1.20:5001', server_id: '90726e5714364abe', pairing_id: 'CCWW5HVZ', expires_at: '2026-10-20T20:36:00Z' };
  const parse = (o: unknown) => parsePairingQr(JSON.stringify(o), now);

  test('missing alt_urls stays backward compatible', () => {
    expect(parse(base)).toMatchObject({ ok: true, payload: { serverUrl: 'http://192.168.1.20:5001', altUrls: [] } });
  });

  test('valid alternates are kept, normalised and de-duplicated', () => {
    const r = parse({ ...base, alt_urls: ['http://mac.tail1234.ts.net:5001/', 'http://100.101.102.103:5001', 'http://192.168.1.20:5001', 'http://100.101.102.103:5001'] });
    expect(r).toMatchObject({ ok: true, payload: { altUrls: ['http://mac.tail1234.ts.net:5001', 'http://100.101.102.103:5001'] } });
  });

  test('unsafe or malformed alternates are dropped, not trusted', () => {
    const r = parse({ ...base, alt_urls: ['http://8.8.8.8:5001', 'ftp://10.0.0.1', 'http://10.0.0.2:5001/path', 'http://u:p@10.0.0.3', 42, 'https://vault.example.com'] });
    expect(r).toMatchObject({ ok: true, payload: { altUrls: ['https://vault.example.com'] } });
    expect(parse({ ...base, alt_urls: 'http://10.0.0.1' })).toMatchObject({ ok: true, payload: { altUrls: [] } });
  });

  test('alternates are capped', () => {
    const many = Array.from({ length: 10 }, (_, i) => `http://10.0.0.${i + 1}:5001`);
    const r = parse({ ...base, alt_urls: many });
    expect(r.ok && r.payload.altUrls.length).toBe(MAX_ALT_URLS);
  });
});

describe('failover', () => {
  test('orderedUrls puts the primary first without duplicates', () => {
    expect(orderedUrls('http://a:1/', ['http://b:1', 'http://a:1', 'http://b:1/'])).toEqual(['http://a:1', 'http://b:1']);
    expect(orderedUrls('http://a:1', undefined)).toEqual(['http://a:1']);
  });

  test('falls back to an alternate URL when the primary is unreachable', async () => {
    const tried: string[] = [];
    const r = await firstReachable(['http://192.168.1.20:5001', 'http://mac.tail1234.ts.net:5001'], async (u) => {
      tried.push(u);
      if (u.includes('192.168')) throw new ApiError('offline', 'down');
      return 'ok';
    });
    expect(r).toEqual({ url: 'http://mac.tail1234.ts.net:5001', value: 'ok' });
    expect(tried).toHaveLength(2);
  });

  test('auth errors are not failed over and all-down reports the primary error', async () => {
    const attempt = jest.fn(async () => {
      throw new ApiError('revoked', 'revoked');
    });
    await expect(firstReachable(['http://a:1', 'http://b:1'], attempt)).rejects.toMatchObject({ kind: 'revoked' });
    expect(attempt).toHaveBeenCalledTimes(1);
    let n = 0;
    await expect(firstReachable(['http://a:1', 'http://b:1'], async () => {
      throw new ApiError(n++ === 0 ? 'timeout' : 'offline', 'x');
    })).rejects.toMatchObject({ kind: 'timeout' });
    expect(shouldFailOver(new ApiError('unauthorized', 'x'))).toBe(false);
    expect(shouldFailOver(new ApiError('host_rejected', 'x'))).toBe(true);
  });
});
