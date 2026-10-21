/**
 * Optional daily digest (Settings → Reminders). Notification permission is
 * requested only when the user turns it on. The scheduled notification lists
 * what is ready to review (titles only); its text is refreshed whenever the app
 * opens or the background task runs, so the morning digest is current. The
 * channel hides content on a secure lock screen.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { rangeFor } from '../core/dates';
import { digestMessage } from '../core/digest';
import { getRepo } from './db';
import { getSettings } from './settings';

const CHANNEL = 'qivra-digest';
const ID_KEY = 'qivra-daily-review';
export const DIGEST_HOUR = 9;

async function currentDigest(): Promise<{ title: string; body: string }> {
  const repo = await getRepo();
  const s = await getSettings();
  const day = rangeFor('today', Date.now(), s.timezone).startIso.slice(0, 10);
  const feed = await repo.homeFeed(day, 3);
  const total = await repo.countWhere(`archived = 0 AND status = 'READY' AND last_viewed_at IS NULL`);
  return digestMessage(feed.ready, total, feed.resurface);
}

async function schedule(hour: number, minute: number): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Daily digest', importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }
  const content = await currentDigest();
  await Notifications.cancelScheduledNotificationAsync(ID_KEY).catch(() => undefined);
  await Notifications.scheduleNotificationAsync({
    identifier: ID_KEY,
    content: { ...content, data: { route: 'Today' } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL },
  });
}

export async function enableDailyReminder(hour = DIGEST_HOUR, minute = 0): Promise<'enabled' | 'denied'> {
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain) granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return 'denied';
  await schedule(hour, minute);
  return 'enabled';
}

/** Re-schedule with up-to-date text. A no-op unless the digest is on and allowed. */
export async function refreshDailyDigest(): Promise<void> {
  try {
    if (!(await getSettings()).dailyReminder) return;
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    await schedule(DIGEST_HOUR, 0);
  } catch {
    // The digest is a convenience; never block the caller.
  }
}

export async function disableDailyReminder(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(ID_KEY).catch(() => undefined);
}
