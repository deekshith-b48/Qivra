import { addDays, detectRangeIntent, localDate, rangeFor, tzOffsetMs, zonedMidnightUtc } from '../../src/core/dates';

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
