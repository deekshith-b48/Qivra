import { formatReminder, notificationLink, reminderPresets } from '../../src/core/reminderTimes';

const byKey = (now: Date) => Object.fromEntries(reminderPresets(now).map((p) => [p.key, p.at]));

test('presets on a Wednesday afternoon: tonight 20:00, tomorrow 9:00, Saturday 10:00, Monday 9:00', () => {
  const now = new Date(2026, 9, 21, 15, 30); // Wed 21 Oct 2026, 15:30 local
  const p = byKey(now);
  expect(p.tonight).toEqual(new Date(2026, 9, 21, 20, 0));
  expect(p.tomorrow).toEqual(new Date(2026, 9, 22, 9, 0));
  expect(p.weekend).toEqual(new Date(2026, 9, 24, 10, 0));
  expect(p.nextWeek).toEqual(new Date(2026, 9, 26, 9, 0));
});

test('late at night "tonight" moves to tomorrow evening; every preset is in the future', () => {
  const now = new Date(2026, 9, 24, 22, 0); // Saturday 22:00
  const presets = reminderPresets(now);
  expect(presets.find((p) => p.key === 'tonight')).toMatchObject({ label: 'Tomorrow evening', at: new Date(2026, 9, 25, 20, 0) });
  expect(presets.find((p) => p.key === 'weekend')?.at).toEqual(new Date(2026, 9, 31, 10, 0)); // Saturday 10:00 has passed
  for (const p of presets) expect(p.at.getTime()).toBeGreaterThan(now.getTime());
});

test('reminder labels are short and relative', () => {
  const now = new Date(2026, 9, 21, 15, 0);
  expect(formatReminder(new Date(2026, 9, 21, 20, 0).toISOString(), now)).toBe('Today 20:00');
  expect(formatReminder(new Date(2026, 9, 22, 9, 0).toISOString(), now)).toBe('Tomorrow 9:00');
  expect(formatReminder(new Date(2026, 10, 12, 9, 0).toISOString(), now)).toBe('12 Nov 9:00');
});

test('a notification opens only Qivra links', () => {
  expect(notificationLink({ url: 'qivra://item/it_123' })).toBe('qivra://item/it_123');
  expect(notificationLink({ url: 'https://evil.example/x' })).toBeNull();
  expect(notificationLink({ url: 'qivra://item/x?y=<script>' })).toBeNull();
  expect(notificationLink(undefined)).toBeNull();
});
