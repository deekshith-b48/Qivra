/**
 * Optional daily review reminder (replaces SuperBrain's per-post Watch Later
 * notifications). Notification permission is requested only when the user
 * turns the reminder on. The notification never contains item content.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const CHANNEL = 'qivra-reminders';
const ID_KEY = 'qivra-daily-review';

export async function enableDailyReminder(hour = 20, minute = 0): Promise<'enabled' | 'denied'> {
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain) granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return 'denied';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Daily review', importance: Notifications.AndroidImportance.DEFAULT });
  }
  await Notifications.cancelScheduledNotificationAsync(ID_KEY).catch(() => undefined);
  await Notifications.scheduleNotificationAsync({
    identifier: ID_KEY,
    content: { title: 'Qivra', body: 'Review what you saved today.', data: { route: 'Today' } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute, channelId: CHANNEL },
  });
  return 'enabled';
}

export async function disableDailyReminder(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(ID_KEY).catch(() => undefined);
}
