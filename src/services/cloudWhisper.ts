/**
 * Speech-to-English from the phone with the user's own Groq key (no laptop server): Whisper's translation mode
 * writes English whatever language is spoken (Qivra works in English). Used for X and Instagram videos, shared
 * audio/video files and long voice notes.
 * The file goes straight from the phone to Groq; the key never leaves secure storage
 * except in the Authorization header, and is never logged.
 */

import * as FS from 'expo-file-system/legacy';
import { parseWhisperVerbose, type WhisperResult } from '../core/whisper';
import { getSecret, SECRET_KEYS } from './secure';
import { getSettings } from './settings';

const GROQ_HOST = 'api.groq.com';
/** Translation (speech → English) needs the full model; turbo only transcribes. */
export const WHISPER_MODEL = 'whisper-large-v3';
/** Groq's upload limit for the free tier. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export class CloudWhisperError extends Error {
  constructor(public code: string, message: string, public retryable: boolean) {
    super(message);
  }
}

/** Groq is the configured AI provider, the user allowed sending content to it, and a key is stored. */
export async function cloudWhisperReady(): Promise<boolean> {
  const s = await getSettings();
  if (!s.ai.enabled || !s.ai.externalConsent || !s.ai.baseUrl) return false;
  try {
    if (new URL(s.ai.baseUrl).hostname !== GROQ_HOST) return false;
  } catch {
    return false;
  }
  return !!(await getSecret(SECRET_KEYS.aiApiKey));
}

async function sizeOf(uri: string): Promise<number | null> {
  const info = (await FS.getInfoAsync(uri, { size: true } as never)) as { exists: boolean; size?: number };
  return info.exists && typeof info.size === 'number' ? info.size : null;
}

/** Download a public video into the cache (deleted by the caller), refusing files over Groq's limit. */
export async function downloadToCache(url: string, name: string): Promise<string> {
  const to = `${FS.cacheDirectory}cloud-${name.replace(/[^\w.-]/g, '_')}`;
  const r = await FS.downloadAsync(url, to);
  if (r.status >= 400) {
    await FS.deleteAsync(to, { idempotent: true }).catch(() => undefined);
    throw new CloudWhisperError('DOWNLOAD_FAILED', `The video could not be downloaded (${r.status}).`, r.status === 429 || r.status >= 500);
  }
  const size = await sizeOf(to);
  if (size !== null && size > MAX_UPLOAD_BYTES) {
    await FS.deleteAsync(to, { idempotent: true }).catch(() => undefined);
    throw new CloudWhisperError('FILE_TOO_LARGE', 'This video is longer than Groq can transcribe in one go (25 MB). Import a transcript instead.', false);
  }
  return to;
}

/** Remove a downloaded video once it has been transcribed (or failed). */
export async function deleteCached(uri: string): Promise<void> {
  await FS.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

/** Transcribe a local audio/video file into English with Groq Whisper (`language` is then always 'en'). */
export async function transcribeMedia(fileUri: string, mime: string, name: string): Promise<WhisperResult> {
  const s = await getSettings();
  const key = await getSecret(SECRET_KEYS.aiApiKey);
  if (!(await cloudWhisperReady()) || !key) throw new CloudWhisperError('NO_PROVIDER', 'Add your Groq key in Settings → AI models to transcribe on the phone.', false);
  const size = await sizeOf(fileUri);
  if (size !== null && size > MAX_UPLOAD_BYTES) {
    throw new CloudWhisperError('FILE_TOO_LARGE', 'This file is over 25 MB, the most Groq accepts. Import a shorter clip or a transcript.', false);
  }
  const form = new FormData();
  form.append('file', { uri: fileUri, name, type: mime || 'application/octet-stream' } as unknown as Blob);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 180_000);
  let res: Response;
  try {
    res = await fetch(`${s.ai.baseUrl.replace(/\/+$/, '')}/audio/translations`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, body: form, signal: ctl.signal,
    });
  } catch {
    throw new CloudWhisperError('OFFLINE', 'Could not reach Groq. Check your connection.', true);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new CloudWhisperError('AUTH', 'Groq rejected your key. Add it again in Settings → AI models.', false);
  if (res.status === 413) throw new CloudWhisperError('FILE_TOO_LARGE', 'This file is too large for Groq. Import a shorter clip or a transcript.', false);
  if (res.status === 429) throw new CloudWhisperError('RATE_LIMIT', 'Groq is busy (rate limit). Qivra will try again shortly.', true);
  if (!res.ok) throw new CloudWhisperError('PROVIDER_ERROR', `Groq could not transcribe this (${res.status}).`, res.status >= 500);
  // In translation mode Whisper reports the language that was spoken; the text is English.
  return { ...parseWhisperVerbose(await res.json()), language: 'en' };
}
