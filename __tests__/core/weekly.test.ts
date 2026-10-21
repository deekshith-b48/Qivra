import { isoWeekKey, maybeGenerateWeeklyReport, weeklySlot, WEEKLY_REPORT_META, type WeeklyDeps } from '../../src/core/weekly';

function deps(tz: string, enabled = true) {
  const meta = new Map<string, string>();
  const generated: { from: string; to: string }[] = [];
  const notified: string[] = [];
  const d: WeeklyDeps = {
    settings: async () => ({ weeklyReport: enabled, timezone: tz }),
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => void meta.set(k, v),
    generate: async (range) => {
      generated.push(range);
      return { id: `rep_${generated.length}`, title: 'Weekly' };
    },
    notify: async (r) => void notified.push(r.id),
  };
  return { d, meta, generated, notified };
}

describe('weekly report schedule', () => {
  test('ISO week keys, including year boundaries', () => {
    expect(isoWeekKey('2026-10-26')).toBe('2026-W44');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
  });

  test('covers last Monday–Sunday and is due only from Monday 06:00 local time', () => {
    // 2026-10-26 is a Monday. Asia/Kolkata is UTC+05:30.
    expect(weeklySlot(Date.parse('2026-10-26T00:29:00Z'), 'Asia/Kolkata')).toEqual({ weekKey: '2026-W44', from: '2026-10-19', to: '2026-10-25', due: false });
    expect(weeklySlot(Date.parse('2026-10-26T00:30:00Z'), 'Asia/Kolkata').due).toBe(true);
    // Same instant, different zone: Monday 09:00 UTC is 05:00 in New York (EDT).
    expect(weeklySlot(Date.parse('2026-10-26T09:00:00Z'), 'UTC').due).toBe(true);
    expect(weeklySlot(Date.parse('2026-10-26T09:00:00Z'), 'America/New_York').due).toBe(false);
    // Sunday still belongs to the previous week.
    expect(weeklySlot(Date.parse('2026-10-25T20:00:00Z'), 'UTC')).toMatchObject({ weekKey: '2026-W43', from: '2026-10-12', to: '2026-10-18', due: true });
  });

  test('generates once per ISO week, only after Monday 06:00, and notifies with the report id', async () => {
    const { d, meta, generated, notified } = deps('Asia/Kolkata');
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-26T00:00:00Z'), d)).toEqual({ skipped: 'not-yet' }); // Mon 05:30 IST
    expect(generated).toHaveLength(0);

    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-26T01:00:00Z'), d)).toEqual({ generated: { id: 'rep_1', weekKey: '2026-W44' } });
    expect(generated).toEqual([{ from: '2026-10-19', to: '2026-10-25' }]);
    expect(notified).toEqual(['rep_1']);
    expect(meta.get(WEEKLY_REPORT_META)).toBe('2026-W44');

    // Later the same week (background run, app resume): nothing new.
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-26T12:00:00Z'), d)).toEqual({ skipped: 'done' });
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-31T12:00:00Z'), d)).toEqual({ skipped: 'done' });
    // Sunday 23:59 IST is still the same week.
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-11-01T18:29:00Z'), d)).toEqual({ skipped: 'done' });
    // Next Monday before 06:00: still waiting; after: the next week's report.
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-11-02T00:00:00Z'), d)).toEqual({ skipped: 'not-yet' });
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-11-02T03:00:00Z'), d)).toEqual({ generated: { id: 'rep_2', weekKey: '2026-W45' } });
    expect(generated[1]).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });

  test('missed Monday: runs on the first opportunity later that week', async () => {
    const { d, generated } = deps('UTC');
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-28T15:00:00Z'), d)).toMatchObject({ generated: { weekKey: '2026-W44' } });
    expect(generated).toEqual([{ from: '2026-10-19', to: '2026-10-25' }]);
  });

  test('disabled: never generates', async () => {
    const { d, generated } = deps('UTC', false);
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-26T12:00:00Z'), d)).toEqual({ skipped: 'disabled' });
    expect(generated).toHaveLength(0);
  });

  test('a failed generation is retried; a failed notification is not', async () => {
    const { d, meta, generated } = deps('UTC');
    const gen = d.generate;
    d.generate = async () => { throw new Error('db busy'); };
    await expect(maybeGenerateWeeklyReport(Date.parse('2026-10-26T07:00:00Z'), d)).rejects.toThrow('db busy');
    expect(meta.has(WEEKLY_REPORT_META)).toBe(false);
    d.generate = gen;
    d.notify = async () => { throw new Error('no permission'); };
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-26T08:00:00Z'), d)).toMatchObject({ generated: { weekKey: '2026-W44' } });
    expect(await maybeGenerateWeeklyReport(Date.parse('2026-10-26T09:00:00Z'), d)).toEqual({ skipped: 'done' });
    expect(generated).toHaveLength(1);
  });

  test('overlapping calls produce one report', async () => {
    const { d, generated } = deps('UTC');
    const now = Date.parse('2026-10-26T07:00:00Z');
    const results = await Promise.all([maybeGenerateWeeklyReport(now, d), maybeGenerateWeeklyReport(now, d)]);
    expect(generated).toHaveLength(1);
    expect(results.map((r) => ('generated' in r ? 'generated' : r.skipped)).sort()).toEqual(['busy', 'generated']);
  });
});
