import { addDays, detectRangeIntent, localDate, rangeFor, tzOffsetMs, zonedMidnightUtc } from '../../src/core/dates';
import { formatPairingCode, manualPairing, normalizePairingCode, parsePairingQr } from '../../src/core/qr';

describe('timezone-aware report ranges', () => {
  const now = Date.parse('2026-10-20T20:00:00Z'); // 01:30 on Oct 21 in Kolkata

  test('today differs by timezone', () => {
    expect(rangeFor('today', now, 'Asia/Kolkata')).toMatchObject({
      startIso: '2026-10-20T18:30:00.000Z', endIso: '2026-10-21T18:30:00.000Z', firstDay: '2026-10-21',
    });
    expect(rangeFor('today', now, 'UTC')).toMatchObject({ startIso: '2026-10-20T00:00:00.000Z', endIso: '2026-10-21T00:00:00.000Z' });
    expect(rangeFor('today', now, 'America/Los_Angeles').firstDay).toBe('2026-10-20');
  });

  test('yesterday and week', () => {
    expect(rangeFor('yesterday', now, 'Asia/Kolkata').firstDay).toBe('2026-10-20');
    const w = rangeFor('week', now, 'UTC');
    expect([w.firstDay, w.lastDay]).toEqual(['2026-10-14', '2026-10-20']);
  });

  test('DST: New York day of fall-back is 25 hours long', () => {
    const r = rangeFor('custom', now, 'America/New_York', { from: '2026-11-01', to: '2026-11-01' });
    expect(Date.parse(r.endIso) - Date.parse(r.startIso)).toBe(25 * 3600_000);
    expect(r.startIso).toBe('2026-11-01T04:00:00.000Z');
  });

  test('helpers', () => {
    expect(tzOffsetMs(now, 'Asia/Kolkata')).toBe(5.5 * 3600_000);
    expect(localDate(now, 'Asia/Kolkata')).toBe('2026-10-21');
    expect(new Date(zonedMidnightUtc(2026, 1, 1, 'Asia/Tokyo')).toISOString()).toBe('2025-12-31T15:00:00.000Z');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('intent detection', () => {
    expect(detectRangeIntent('What did I save today about Claude Code?')).toBe('today');
    expect(detectRangeIntent("Summarize this week's AI agent tutorials")).toBe('week');
    expect(detectRangeIntent('Compare the GitHub projects')).toBeNull();
  });
});

describe('QR pairing payload validation', () => {
  const now = Date.parse('2026-10-20T20:31:00Z');
  const good = {
    version: 1, product: 'Qivra', server_url: 'http://10.109.230.239:5001', server_id: '90726e5714364abe',
    pairing_id: 'CCWW5HVZ', expires_at: '2026-10-20T20:36:39.048Z',
  };
  const parse = (o: unknown) => parsePairingQr(JSON.stringify(o), now);

  test('valid payload', () => {
    expect(parse(good)).toEqual({ ok: true, payload: {
      version: 1, product: 'Qivra', serverUrl: 'http://10.109.230.239:5001', serverId: '90726e5714364abe', pairingId: 'CCWW5HVZ',
      expiresAt: '2026-10-20T20:36:39.048Z', cleartext: true,
    } });
  });

  test.each([
    ['not json', 'hello', 'NOT_JSON'],
    ['array', '[1]', 'NOT_JSON'],
    ['oversized', JSON.stringify({ ...good, pad: 'x'.repeat(2000) }), 'TOO_LARGE'],
  ])('%s', (_n, raw, err) => expect(parsePairingQr(raw, now)).toEqual({ ok: false, error: err }));

  test.each([
    ['wrong product', { ...good, product: 'SuperBrain' }, 'WRONG_PRODUCT'],
    ['future version', { ...good, version: 2 }, 'UNSUPPORTED_VERSION'],
    ['public http host', { ...good, server_url: 'http://evil.example.com:5000' }, 'CLEARTEXT_PUBLIC_HOST'],
    ['javascript url', { ...good, server_url: 'javascript:alert(1)' }, 'BAD_SERVER_URL'],
    ['url with path', { ...good, server_url: 'http://192.168.1.2:5000/admin' }, 'BAD_SERVER_URL'],
    ['bad code alphabet', { ...good, pairing_id: 'UUUU-UUUU' }, 'BAD_PAIRING_ID'],
    ['short code', { ...good, pairing_id: 'ABC' }, 'BAD_PAIRING_ID'],
    ['bad server id', { ...good, server_id: '<script>' }, 'BAD_SERVER_ID'],
    ['bad expiry', { ...good, expires_at: 'tomorrow' }, 'BAD_EXPIRY'],
    ['expired', { ...good, expires_at: '2026-10-20T20:20:00Z' }, 'EXPIRED'],
    ['legacy superbrain token qr', { url: 'http://192.168.1.2:5000', token: 'ABCD1234' }, 'LEGACY_SUPERBRAIN'],
  ])('rejects %s', (_n, obj, err) => expect(parse(obj)).toEqual({ ok: false, error: err }));

  test('small clock skew is tolerated', () => {
    expect(parse({ ...good, expires_at: '2026-10-20T20:30:00Z' }).ok).toBe(true);
  });

  test('https to a public host is allowed', () => {
    expect(parse({ ...good, server_url: 'https://qivra.example.com' })).toMatchObject({ ok: true, payload: { cleartext: false } });
  });

  test('manual entry', () => {
    expect(manualPairing('192.168.1.20:5001', 'ccww-5hvz')).toMatchObject({ ok: true, payload: { serverUrl: 'http://192.168.1.20:5001', pairingId: 'CCWW5HVZ' } });
    expect(manualPairing('192.168.1.20:5001', '123')).toMatchObject({ ok: false, field: 'code' });
    expect(manualPairing('http://8.8.8.8', 'CCWW5HVZ')).toMatchObject({ ok: false, field: 'url' });
    expect(normalizePairingCode(' o1-il ')).toBe('0111');
    expect(formatPairingCode('CCWW5HVZ')).toBe('CCWW-5HVZ');
  });
});
