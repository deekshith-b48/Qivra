/**
 * Preset times for "Remind me to revisit this" (device local time, pure and tested).
 * A preset that has already passed today moves to the next day.
 */

export interface ReminderPreset {
  key: 'tonight' | 'tomorrow' | 'weekend' | 'nextWeek';
  label: string;
  at: Date;
}

function at(base: Date, addDays: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export function reminderPresets(now: Date): ReminderPreset[] {
  const day = now.getDay(); // 0 Sunday … 6 Saturday
  const tonight = now.getHours() < 20 ? at(now, 0, 20) : at(now, 1, 20);
  const toSaturday = (6 - day + 7) % 7 || (now.getHours() < 10 ? 0 : 7);
  const toMonday = ((1 - day + 7) % 7) || 7;
  return [
    { key: 'tonight', label: now.getHours() < 20 ? 'Tonight' : 'Tomorrow evening', at: tonight },
    { key: 'tomorrow', label: 'Tomorrow morning', at: at(now, 1, 9) },
    { key: 'weekend', label: 'This weekend', at: at(now, toSaturday, 10) },
    { key: 'nextWeek', label: 'Next week', at: at(now, toMonday, 9) },
  ];
}

/** "Tomorrow 9:00", "Sat 10:00", "12 Nov 9:00" — short, for the item page and lists. */
export function formatReminder(atIso: string, now: Date): string {
  const d = new Date(atIso);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((at(d, 0, 0).getTime() - at(now, 0, 0).getTime()) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en', { weekday: 'short' })} ${time}`;
  return `${d.getDate()} ${d.toLocaleDateString('en', { month: 'short' })} ${time}`;
}

/** The in-app link a notification carries, if it is one of Qivra's own (never an outside URL). */
export function notificationLink(data: unknown): string | null {
  const url = data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined;
  return typeof url === 'string' && /^qivra:\/\/[\w/-]+$/.test(url) ? url : null;
}
