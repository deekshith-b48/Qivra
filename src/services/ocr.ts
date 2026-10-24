/**
 * On-device OCR for shared screenshots and photos.
 *
 * Google ML Kit text recognition (@react-native-ml-kit/text-recognition, MIT)
 * runs entirely on the phone with bundled models — no network. The recognised
 * text is stored as a transcript with source `image_ocr` (an ARTICLE_SOURCES
 * entry, so it is treated as text rather than speech), which makes it
 * searchable and feeds summaries, key points and flashcards.
 */

import { detectLanguage } from '../core/language';
import { isImageFile } from '../core/share';
import type { Repo } from '../db/repo';
import type { Item } from '../db/types';

export const OCR_SOURCE = 'image_ocr';

type Recognize = (uri: string, script?: string) => Promise<{ text: string }>;

/** The native module is loaded lazily so a build without it (or Jest) still runs the rest of the app. */
function loadRecognizer(): Recognize | null {
  try {
    const mod = require('@react-native-ml-kit/text-recognition');
    const tr = (mod.default ?? mod) as { recognize?: Recognize };
    return typeof tr.recognize === 'function' ? (uri, script) => tr.recognize!(uri, script) : null;
  } catch {
    return null;
  }
}

/** ML Kit script models also read Latin, so pick the one matching the phone's language. */
export function scriptForLanguage(lang: string): string {
  const l = lang.toLowerCase().split('-')[0];
  if (l === 'zh') return 'Chinese';
  if (l === 'ja') return 'Japanese';
  if (l === 'ko') return 'Korean';
  if (['hi', 'mr', 'ne', 'sa'].includes(l)) return 'Devanagari';
  return 'Latin';
}

/** Collapse OCR whitespace: keep line breaks, drop empty lines and runs of spaces. */
export function cleanOcrText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function deviceLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? 'en';
  } catch {
    return 'en';
  }
}

export type OcrOutcome = 'stored' | 'exists' | 'no_images' | 'no_text' | 'unavailable';

/**
 * Recognise text in an item's attached images and store it as one `image_ocr`
 * transcript (one segment per image). Idempotent: does nothing once stored.
 */
export async function ocrItemImages(repo: Repo, item: Item, recognize: Recognize | null = loadRecognizer()): Promise<OcrOutcome> {
  const images = (await repo.listMedia(item.id)).filter((m) => isImageFile(m.name, m.mime)).reverse();
  if (!images.length) return 'no_images';
  if ((await repo.listTranscripts(item.id)).some((t) => t.source === OCR_SOURCE)) return 'exists';
  if (!recognize) return 'unavailable';
  const script = scriptForLanguage(deviceLanguage());
  const texts: string[] = [];
  let failures = 0;
  for (const m of images) {
    try {
      const text = cleanOcrText((await recognize(m.uri, script)).text ?? '');
      if (text) texts.push(text);
    } catch {
      failures++;
    }
  }
  if (!texts.length) return failures === images.length ? 'unavailable' : 'no_text';
  const lang = detectLanguage(texts.join(' '));
  await repo.upsertTranscript({
    itemId: item.id, language: lang.code, languageMethod: 'heuristic', kind: 'original', source: OCR_SOURCE,
    provider: 'mlkit-text-recognition', format: 'txt', segments: texts.map((text) => ({ startMs: null, endMs: null, text })),
  });
  return 'stored';
}

export const VIDEO_OCR_SOURCE = 'video_ocr';

type Thumbnail = (uri: string, opts: { time: number; quality: number }) => Promise<{ uri: string }>;

function loadThumbnailer(): Thumbnail | null {
  try {
    const mod = require('expo-video-thumbnails') as { getThumbnailAsync?: Thumbnail };
    return typeof mod.getThumbnailAsync === 'function' ? mod.getThumbnailAsync : null;
  } catch {
    return null;
  }
}

/**
 * On-screen text of a video with no speech (captions burnt into a reel): read a frame
 * about every 2 seconds (15 at most) with ML Kit and store the distinct lines with their
 * timestamps as a `video_ocr` transcript. Returns false when nothing was found.
 */
export async function ocrVideoFrames(
  repo: Repo, itemId: string, fileUri: string, durationMs: number,
  recognize: Recognize | null = loadRecognizer(), thumbnail: Thumbnail | null = loadThumbnailer(),
): Promise<boolean> {
  if (!recognize || !thumbnail || durationMs <= 0) return false;
  const step = Math.max(2000, Math.ceil(durationMs / 15));
  const script = scriptForLanguage(deviceLanguage());
  const segments: { startMs: number; endMs: number; text: string }[] = [];
  let last = '';
  for (let t = 500; t < durationMs; t += step) {
    try {
      const frame = await thumbnail(fileUri, { time: t, quality: 0.7 });
      const text = cleanOcrText((await recognize(frame.uri, script)).text ?? '');
      if (text && text !== last) segments.push({ startMs: t, endMs: Math.min(durationMs, t + step), text });
      if (text) last = text;
    } catch {
      /* skip unreadable frames */
    }
  }
  if (!segments.length) return false;
  await repo.upsertTranscript({
    itemId, language: detectLanguage(segments.map((s) => s.text).join(' ')).code, languageMethod: 'heuristic', kind: 'original',
    source: VIDEO_OCR_SOURCE, provider: 'mlkit-text-recognition', format: 'txt', segments,
  });
  return true;
}
