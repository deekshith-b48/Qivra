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
  /** Optional embeddings-only provider (a free Gemini key) for search by meaning and Related items. */
  embed?: { enabled: boolean; baseUrl: string; model: string };
}

export interface Settings {
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  libraryView: 'list' | 'grid';
  ai: AiSettings;
  dailyReminder: boolean;
  scheduledDailyReport: boolean;
  /** Build last week's report every Monday morning and notify. */
  weeklyReport: boolean;
  serverProcessing: boolean;
  /** Automatically transcribe shared videos (YouTube captions in English, else Groq with the user's key). */
  autoTranscribe: boolean;
  voice: VoiceSettings;
  /** Developer mode (opt-in at onboarding): shows the Dev tab with trends, Claude Code, follow-ups and habits. */
  devMode: boolean;
  /** Topics or repos to follow in Dev mode (at most 5). */
  devFollows: string[];
  /** Morning notification when followed topics have something new. */
  devFollowNotify: boolean;
}

export const MAX_DEV_FOLLOWS = 5;

export interface VoiceSettings {
  /** On-device speech model (see src/core/voiceModels.ts). */
  modelId: string;
  /** 'auto' or a language code. */
  language: string;
  /** Send recordings to the paired server instead of transcribing on the phone. */
  /** Send voice notes to Groq Whisper (user's key) instead of the on-device model: up to 12 minutes. */
  preferCloud?: boolean;
}

export const DEFAULT_VOICE: VoiceSettings = { modelId: 'whisper-base', language: 'auto' };

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
    libraryView: s.libraryView ?? 'grid',
    ai: { ...DEFAULT_AI, ...(s.ai ?? {}) },
    dailyReminder: s.dailyReminder ?? false,
    scheduledDailyReport: s.scheduledDailyReport ?? false,
    weeklyReport: s.weeklyReport ?? false,
    serverProcessing: s.serverProcessing ?? false,
    autoTranscribe: s.autoTranscribe ?? true,
    voice: { ...DEFAULT_VOICE, ...(s.voice ?? {}) },
    devMode: s.devMode ?? false,
    devFollows: Array.isArray(s.devFollows) ? s.devFollows.filter((x) => typeof x === 'string' && x.trim()).slice(0, MAX_DEV_FOLLOWS) : ['Claude Code', 'MCP'],
    devFollowNotify: s.devFollowNotify ?? false,
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const repo = await getRepo();
  const current = await getSettings();
  const next = { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) }, voice: { ...current.voice, ...(patch.voice ?? {}) } };
  await repo.setJson('settings', next);
  emit('settings');
  return next;
}
