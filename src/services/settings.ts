/** Non-secret user settings, stored in the local database `meta` table. */

import * as Localization from 'expo-localization';
import { isValidTimeZone } from '../core/dates';
import { emit } from './events';
import { getRepo } from './db';

export interface AiSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  embeddingModel: string;
  /** User acknowledged that content is sent to a non-local provider. */
  externalConsent: boolean;
  /** Run model enrichment automatically after capture (otherwise only on request). */
  autoEnrich: boolean;
}

export interface Settings {
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  libraryView: 'list' | 'grid';
  ai: AiSettings;
  dailyReminder: boolean;
  scheduledDailyReport: boolean;
  serverProcessing: boolean;
}

export const DEFAULT_AI: AiSettings = { enabled: false, baseUrl: '', model: '', embeddingModel: '', externalConsent: false, autoEnrich: false };

export function deviceTimeZone(): string {
  try {
    const tz = Localization.getCalendars()[0]?.timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    /* fall through */
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    /* fall through */
  }
  return 'UTC';
}

export async function getSettings(): Promise<Settings> {
  const repo = await getRepo();
  const s = await repo.getJson<Partial<Settings>>('settings', {});
  return {
    timezone: s.timezone && isValidTimeZone(s.timezone) ? s.timezone : deviceTimeZone(),
    theme: s.theme ?? 'system',
    libraryView: s.libraryView ?? 'list',
    ai: { ...DEFAULT_AI, ...(s.ai ?? {}) },
    dailyReminder: s.dailyReminder ?? false,
    scheduledDailyReport: s.scheduledDailyReport ?? false,
    serverProcessing: s.serverProcessing ?? false,
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const repo = await getRepo();
  const current = await getSettings();
  const next = { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) } };
  await repo.setJson('settings', next);
  emit('settings');
  return next;
}
