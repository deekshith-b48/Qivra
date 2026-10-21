/**
 * Scheduled weekly report: once per ISO week, after Monday 06:00 in the
 * user's timezone, build the report for the previous Monday–Sunday. The last
 * week handled is remembered in repo meta so background runs and app resumes
 * never produce it twice. I/O is injected so the rule is testable under Node.
 */

import { addDays, localDate, tzOffsetMs } from './dates';

export const WEEKLY_REPORT_META = 'reports.weekly.lastWeek';
export const WEEKLY_REPORT_HOUR = 6;

/** ISO-8601 week key (e.g. "2026-W43") of a YYYY-MM-DD day. */
export function isoWeekKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday decides the ISO year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface WeeklySlot {
  /** ISO week of the current week (the week in which the report is produced). */
  weekKey: string;
  /** Last week, Monday → Sunday (local days, inclusive). */
  from: string;
  to: string;
  /** False on Monday before 06:00 local time. */
  due: boolean;
}

export function weeklySlot(nowMs: number, tz: string): WeeklySlot {
  const today = localDate(nowMs, tz);
  const local = new Date(nowMs + tzOffsetMs(nowMs, tz));
  const dow = local.getUTCDay() || 7; // 1 = Monday … 7 = Sunday
  const monday = addDays(today, 1 - dow);
  return {
    weekKey: isoWeekKey(monday),
    from: addDays(monday, -7),
    to: addDays(monday, -1),
    due: dow !== 1 || local.getUTCHours() >= WEEKLY_REPORT_HOUR,
  };
}

export interface WeeklyDeps {
  settings(): Promise<{ weeklyReport: boolean; timezone: string }>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  generate(range: { from: string; to: string }): Promise<{ id: string; title: string }>;
  notify(report: { id: string; title: string }): Promise<void>;
}

export type WeeklyResult = { generated: { id: string; weekKey: string } } | { skipped: 'disabled' | 'not-yet' | 'done' | 'busy' };

let inFlight = false;

export async function maybeGenerateWeeklyReport(nowMs: number, deps: WeeklyDeps): Promise<WeeklyResult> {
  const s = await deps.settings();
  if (!s.weeklyReport) return { skipped: 'disabled' };
  const slot = weeklySlot(nowMs, s.timezone);
  if (!slot.due) return { skipped: 'not-yet' };
  if ((await deps.getMeta(WEEKLY_REPORT_META)) === slot.weekKey) return { skipped: 'done' };
  // Background task and app resume can overlap in one JS context.
  if (inFlight) return { skipped: 'busy' };
  inFlight = true;
  try {
    const report = await deps.generate({ from: slot.from, to: slot.to });
    // Remember the week before notifying: a failed notification must not cause a second report.
    await deps.setMeta(WEEKLY_REPORT_META, slot.weekKey);
    await deps.notify(report).catch(() => undefined);
    return { generated: { id: report.id, weekKey: slot.weekKey } };
  } finally {
    inFlight = false;
  }
}
