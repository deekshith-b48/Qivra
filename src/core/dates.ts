/**
 * Timezone-aware date ranges for "today", "yesterday", "this week" etc.
 * All storage is UTC ISO-8601; day boundaries are computed in the user's
 * configured IANA timezone (not the device's, which may differ).
 */

export type RangeKind = 'today' | 'yesterday' | 'week' | 'last30' | 'custom';

export interface DateRange {
  startIso: string; // inclusive, UTC
  endIso: string; // exclusive, UTC
  label: string;
  timezone: string;
  firstDay: string; // YYYY-MM-DD local
  lastDay: string; // YYYY-MM-DD local
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function partsOf(utcMs: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Offset (ms) of `tz` from UTC at the given instant. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const p = partsOf(utcMs, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of local midnight on y-m-d in tz (handles DST transitions). */
export function zonedMidnightUtc(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const off1 = tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function localDate(utcMs: number, tz: string): string {
  const p = partsOf(utcMs, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function parseDay(day: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid date: ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = parseDay(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function dayRange(firstDay: string, lastDay: string, tz: string, label?: string): DateRange {
  const [y1, m1, d1] = parseDay(firstDay);
  const [y2, m2, d2] = parseDay(addDays(lastDay, 1));
  return {
    startIso: new Date(zonedMidnightUtc(y1, m1, d1, tz)).toISOString(),
    endIso: new Date(zonedMidnightUtc(y2, m2, d2, tz)).toISOString(),
    label: label ?? (firstDay === lastDay ? firstDay : `${firstDay} – ${lastDay}`),
    timezone: tz,
    firstDay,
    lastDay,
  };
}

export function rangeFor(kind: RangeKind, nowMs: number, tz: string, custom?: { from: string; to: string }): DateRange {
  const today = localDate(nowMs, tz);
  switch (kind) {
    case 'today':
      return dayRange(today, today, tz, `Today (${today})`);
    case 'yesterday': {
      const y = addDays(today, -1);
      return dayRange(y, y, tz, `Yesterday (${y})`);
    }
    case 'week':
      return dayRange(addDays(today, -6), today, tz, `Last 7 days (${addDays(today, -6)} – ${today})`);
    case 'last30':
      return dayRange(addDays(today, -29), today, tz, `Last 30 days`);
    case 'custom':
      if (!custom) throw new Error('custom range requires from/to');
      return dayRange(custom.from, custom.to, tz);
  }
}

export function formatLocal(iso: string, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Detect "today", "yesterday", "this week" etc. in a natural-language question. */
export function detectRangeIntent(text: string): RangeKind | null {
  const t = text.toLowerCase();
  if (/\byesterday\b/.test(t)) return 'yesterday';
  if (/\b(today|today's|this morning|tonight)\b/.test(t)) return 'today';
  if (/\b(this week|last 7 days|past week|weekly|last week)\b/.test(t)) return 'week';
  if (/\b(this month|last 30 days|past month)\b/.test(t)) return 'last30';
  return null;
}
