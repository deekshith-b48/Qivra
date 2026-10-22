/**
 * Capture: share-sheet inbox, manual saves, transcript import, media and image import.
 * Items are persisted before any network work happens.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as FS from 'expo-file-system/legacy';
import { newId } from '../core/ids';
import { detectLanguage, isValidLanguageCode } from '../core/language';
import { isShareEnvelope, MAX_MEDIA_BYTES, MAX_TRANSCRIPT_BYTES, mediaKindOf, normalizeShare, safeFileName, transcriptFormatOf, type CaptureRequest } from '../core/share';
import { parseTranscript, TranscriptParseError, type TranscriptFormat } from '../core/transcripts';
import { Repo } from '../db/repo';
import { getRepo } from './db';
import { clearItemReminders } from './reminders';
import { emit } from './events';
import { schedulePipeline } from './processing';

export interface CaptureResult {
  itemId: string | null;
  title: string;
  kind: CaptureRequest['kind'];
  duplicate: boolean;
  status: string;
  error?: string;
}

const MEDIA_DIR = () => `${FS.documentDirectory}media/`;
export const SHARE_INBOX_DIR = () => `${FS.documentDirectory}share_inbox/`;

async function ensureDir(dir: string) {
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) await FS.makeDirectoryAsync(dir, { intermediates: true });
}

function toUri(path: string): string {
  return path.startsWith('file://') || path.startsWith('content://') ? path : `file://${path}`;
}

/** Only files inside the app's own storage may be read or moved by capture. */
function isAppPrivate(uri: string): boolean {
  const doc = FS.documentDirectory ?? '';
  const cache = FS.cacheDirectory ?? '';
  return (!!doc && uri.startsWith(doc)) || (!!cache && uri.startsWith(cache));
}

export async function captureRequest(req: CaptureRequest, origin: 'share' | 'local' = 'local'): Promise<CaptureResult> {
  const repo = await getRepo();
  switch (req.kind) {
    case 'url': {
      const { item, duplicate } = await repo.createItem({ sourceType: req.sourceType, url: req.url, dedupeKey: req.dedupeKey, title: req.title, note: req.note, origin });
      if (duplicate && req.note && !item.note.includes(req.note)) {
        await repo.updateItem(item.id, { note: item.note ? `${item.note}\n\n${req.note}` : req.note });
      }
      if (!duplicate) await schedulePipeline(item.id);
      emit('items');
      return { itemId: item.id, title: item.title || req.url, kind: req.kind, duplicate, status: item.status };
    }
    case 'text': {
      const firstLine = req.text.split('\n')[0].trim();
      const { item, duplicate } = await repo.createItem({
        sourceType: 'note', title: req.title || (firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine), note: req.text,
        dedupeKey: Repo.textDedupeKey(req.text), origin,
      });
      if (!duplicate) await schedulePipeline(item.id);
      emit('items');
      return { itemId: item.id, title: item.title, kind: req.kind, duplicate, status: item.status };
    }
    case 'transcript_file': {
      const uri = toUri(req.file.path);
      if (!isAppPrivate(uri)) return { itemId: null, title: req.file.name, kind: req.kind, duplicate: false, status: 'REJECTED', error: 'File is outside Qivra storage.' };
      const text = await FS.readAsStringAsync(uri);
      const { item } = await repo.createItem({ sourceType: 'file', title: req.file.name.replace(/\.(srt|vtt|txt)$/i, ''), origin });
      try {
        await importTranscriptText(item.id, text, { fileName: req.file.name, format: req.format, source: `import_${req.format}` });
      } catch (e) {
        await repo.setStatus(item.id, 'FAILED_PERMANENT', { code: 'TRANSCRIPT_PARSE_ERROR', message: (e as Error).message });
        emit('items');
        return { itemId: item.id, title: item.title, kind: req.kind, duplicate: false, status: 'FAILED_PERMANENT', error: (e as Error).message };
      } finally {
        await FS.deleteAsync(uri, { idempotent: true });
      }
      return { itemId: item.id, title: item.title, kind: req.kind, duplicate: false, status: 'CAPTURED' };
    }
    case 'media_file': {
      const { item } = await repo.createItem({ sourceType: 'file', title: req.file.name, origin });
      const stored = await storeMedia(toUri(req.file.path), req.file.name, req.file.mime, req.file.size, true);
      await repo.addMedia(item.id, stored);
      await schedulePipeline(item.id);
      emit('items');
      return { itemId: item.id, title: item.title, kind: req.kind, duplicate: false, status: item.status };
    }
    case 'images': {
      // A note item holding the image(s); on-device OCR (services/ocr.ts) runs in the pipeline before enrichment.
      const firstLine = (req.text ?? '').split('\n')[0].trim();
      const fallback = req.files.length > 1 ? `${req.files.length} images` : req.files[0].name.replace(/\.[a-z0-9]{1,5}$/i, '');
      const title = req.title || (firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine) || fallback;
      const { item } = await repo.createItem({ sourceType: 'note', title, note: req.text ?? '', origin });
      for (const f of req.files) {
        const uri = toUri(f.path);
        if (!isAppPrivate(uri)) continue;
        await repo.addMedia(item.id, await storeMedia(uri, f.name, f.mime, f.size, true));
      }
      await schedulePipeline(item.id);
      emit('items');
      return { itemId: item.id, title: item.title, kind: req.kind, duplicate: false, status: item.status };
    }
  }
}

/** Copy (or move) a media file into the controlled media directory with a random name. */
async function storeMedia(srcUri: string, name: string, mime: string, size: number, move: boolean) {
  await ensureDir(MEDIA_DIR());
  const ext = (safeFileName(name).split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
  const dest = `${MEDIA_DIR()}${newId('m')}.${ext}`;
  if (move && isAppPrivate(srcUri)) await FS.moveAsync({ from: srcUri, to: dest });
  else await FS.copyAsync({ from: srcUri, to: dest });
  return { uri: dest, name: safeFileName(name), mime: mime || 'application/octet-stream', size };
}

type DrainResult = { results: CaptureResult[]; rejected: { name: string; reason: string }[] };
let draining: Promise<DrainResult> | null = null;

/**
 * Process envelopes written by the native ShareActivity. Durable: envelopes are deleted only after ingestion.
 * Serialized: app-resume, the qivra://share link and boot can all fire at once; concurrent drains
 * would read the same envelope twice.
 */
export function drainShareInbox(): Promise<DrainResult> {
  const run = (draining ?? Promise.resolve({ results: [], rejected: [] } as DrainResult)).then(() => drainOnce(), () => drainOnce());
  draining = run.finally(() => {
    if (draining === run) draining = null;
  }) as Promise<DrainResult>;
  return run;
}

async function drainOnce(): Promise<DrainResult> {
  const dir = SHARE_INBOX_DIR();
  const info = await FS.getInfoAsync(dir);
  if (!info.exists) return { results: [], rejected: [] };
  const names = (await FS.readDirectoryAsync(dir)).filter((n) => n.endsWith('.json')).sort();
  const results: CaptureResult[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const n of names) {
    const uri = `${dir}${n}`;
    let env: unknown;
    try {
      env = JSON.parse(await FS.readAsStringAsync(uri));
    } catch {
      rejected.push({ name: n, reason: 'Unreadable share payload.' });
      await FS.deleteAsync(uri, { idempotent: true });
      continue;
    }
    if (!isShareEnvelope(env)) {
      rejected.push({ name: n, reason: 'Unsupported share payload.' });
      await FS.deleteAsync(uri, { idempotent: true });
      continue;
    }
    const norm = normalizeShare(env);
    rejected.push(...norm.rejected);
    if (!norm.requests.length && !norm.rejected.length) rejected.push({ name: 'Shared content', reason: 'Nothing that Qivra can save was shared.' });
    for (const req of norm.requests) {
      try {
        results.push(await captureRequest(req, 'share'));
      } catch (e) {
        results.push({ itemId: null, title: req.kind === 'url' ? req.url : req.kind, kind: req.kind, duplicate: false, status: 'FAILED', error: (e as Error).message });
      }
    }
    // Remove leftover copied files that were rejected, then the envelope itself.
    for (const f of env.files ?? []) await FS.deleteAsync(toUri(f.path), { idempotent: true }).catch(() => undefined);
    await FS.deleteAsync(uri, { idempotent: true });
  }
  if (results.length) emit('items');
  return { results, rejected };
}

export async function importTranscriptText(
  itemId: string,
  text: string,
  opts: { fileName?: string; format?: TranscriptFormat; language?: string; kind?: 'original' | 'translation'; source?: string } = {},
): Promise<{ transcriptId: string; segments: number; language: string; hasTimestamps: boolean }> {
  const repo = await getRepo();
  const { format, segments } = parseTranscript(text, opts.format, opts.fileName);
  let language = opts.language && isValidLanguageCode(opts.language) ? opts.language : 'und';
  let method: 'user' | 'heuristic' = opts.language ? 'user' : 'heuristic';
  if (language === 'und') {
    const g = detectLanguage(segments.map((s) => s.text).join(' '));
    language = g.code;
    method = 'heuristic';
  }
  const t = await repo.upsertTranscript({
    itemId, language, languageMethod: method, kind: opts.kind ?? 'original', source: opts.source ?? (opts.fileName ? `import_${format}` : 'paste'), format, segments, provider: 'import',
  });
  await schedulePipeline(itemId);
  emit('items');
  return { transcriptId: t.id, segments: t.segmentCount, language, hasTimestamps: t.hasTimestamps };
}

/** Storage Access Framework picker for SRT/VTT/TXT. */
export async function pickTranscriptFile(): Promise<{ name: string; text: string } | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/x-subrip', 'text/vtt', 'text/plain', 'text/*', 'application/octet-stream'], copyToCacheDirectory: true, multiple: false });
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  try {
    if (!transcriptFormatOf(a.name, a.mimeType ?? '') && !/\.(srt|vtt|txt)$/i.test(a.name)) throw new TranscriptParseError('Choose a .srt, .vtt or .txt file.');
    if ((a.size ?? 0) > MAX_TRANSCRIPT_BYTES) throw new TranscriptParseError('Transcript files must be 5 MB or smaller.');
    return { name: safeFileName(a.name), text: await FS.readAsStringAsync(a.uri) };
  } finally {
    await FS.deleteAsync(a.uri, { idempotent: true }).catch(() => undefined);
  }
}

/** User-authorised audio/video import (copied into app-private storage). */
export async function pickMediaFile(attachTo?: string): Promise<CaptureResult | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['audio/*', 'video/*'], copyToCacheDirectory: true, multiple: false });
  if (res.canceled || !res.assets?.[0]) return null;
  const a = res.assets[0];
  const mime = a.mimeType ?? '';
  if (!mediaKindOf(a.name, mime)) throw new Error('Choose an audio or video file.');
  if ((a.size ?? 0) > MAX_MEDIA_BYTES) {
    await FS.deleteAsync(a.uri, { idempotent: true });
    throw new Error('Media files must be 200 MB or smaller.');
  }
  const repo = await getRepo();
  const stored = await storeMedia(a.uri, a.name, mime, a.size ?? 0, true);
  let itemId = attachTo;
  if (!itemId) itemId = (await repo.createItem({ sourceType: 'file', title: safeFileName(a.name) })).item.id;
  await repo.addMedia(itemId, stored);
  await schedulePipeline(itemId);
  emit('items');
  return { itemId, title: safeFileName(a.name), kind: 'media_file', duplicate: false, status: 'CAPTURED' };
}

/** Before deleting items: remove their local files and cancel their revisit reminders. */
export async function deleteItemFiles(itemIds: string[]): Promise<void> {
  await clearItemReminders(itemIds).catch(() => undefined);
  const repo = await getRepo();
  for (const id of itemIds) await deleteLocalFiles((await repo.listMedia(id)).map((m) => m.uri));
}

export async function deleteLocalFiles(uris: string[]): Promise<void> {
  for (const uri of uris) await FS.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}
