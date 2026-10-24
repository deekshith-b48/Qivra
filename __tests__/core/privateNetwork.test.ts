import { checkServerUrl, isPrivateHost, isPrivateNetworkUrl, isTailnetName } from '../../src/core/net';

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
