/**
 * Opt-in weekly report (Settings → Reminders & schedules). Runs from the
 * background task and on app resume; see `maybeGenerateWeeklyReport` for the
 * once-per-ISO-week rule. The notification uses a channel that hides its
 * content on a secure lock screen.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { maybeGenerateWeeklyReport as decide, type WeeklyResult } from '../core/weekly';
import { getRepo } from './db';
import { generateReport } from './reports';
import { getSettings } from './settings';

const CHANNEL = 'qivra-reports';

async function notifyReady(report: { id: string; title: string }): Promise<void> {
  if (!(await Notifications.getPermissionsAsync()).granted) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Reports', importance: Notifications.AndroidImportance.DEFAULT,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Your weekly report is ready', body: report.title, data: { route: 'ReportDetail', reportId: report.id } },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
  });
}

export async function maybeGenerateWeeklyReport(now = Date.now()): Promise<WeeklyResult | null> {
  try {
    const repo = await getRepo();
    return await decide(now, {
      settings: getSettings,
      getMeta: (k) => repo.getMeta(k),
      setMeta: (k, v) => repo.setMeta(k, v),
      generate: (custom) => generateReport({ kind: 'weekly', custom }),
      notify: notifyReady,
    });
  } catch {
    // A convenience; never block the background task or app resume.
    return null;
  }
}

/** Asked when the user turns the weekly report on. */
export async function enableWeeklyReport(): Promise<'enabled' | 'denied'> {
  const current = await Notifications.getPermissionsAsync();
  let granted = current.granted;
  if (!granted && current.canAskAgain) granted = (await Notifications.requestPermissionsAsync()).granted;
  return granted ? 'enabled' : 'denied';
}
