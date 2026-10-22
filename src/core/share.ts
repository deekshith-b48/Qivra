/**
 * Android share-sheet payload normalisation.
 *
 * The native ShareActivity copies shared content URIs into app-private storage
 * and writes a JSON envelope to the share inbox. This module validates that
 * envelope and turns it into capture requests. It never trusts sizes, names or
 * MIME types blindly.
 */

import { analyzeUrl, extractUrls, type SourceType } from './url';

export const MAX_TEXT_CHARS = 200_000;
export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

export interface SharedFile {
  path: string; // app-private copy written by ShareActivity (file:// URI or absolute path)
  name: string;
  mime: string;
  size: number;
}

export interface ShareEnvelope {
  version: 1;
  id: string;
  action: 'SEND' | 'SEND_MULTIPLE' | 'VIEW';
  receivedAt: string;
  text?: string;
  subject?: string;
  files?: SharedFile[];
  errors?: { name: string; reason: string }[];
}

export type CaptureRequest =
  | { kind: 'url'; url: string; sourceType: SourceType; dedupeKey: string; title?: string; note?: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'transcript_file'; file: SharedFile; format: 'srt' | 'vtt' | 'txt' }
  | { kind: 'media_file'; file: SharedFile; mediaKind: 'audio' | 'video' }
  /** Screenshots/photos shared together become one note item (a carousel when there are several). */
  | { kind: 'images'; files: SharedFile[]; text?: string; title?: string };

export interface NormalizedShare {
  requests: CaptureRequest[];
  rejected: { name: string; reason: string }[];
}

export function transcriptFormatOf(name: string, mime: string): 'srt' | 'vtt' | 'txt' | null {
  const n = name.toLowerCase();
  if (n.endsWith('.srt') || mime === 'application/x-subrip' || mime === 'text/srt') return 'srt';
  if (n.endsWith('.vtt') || mime === 'text/vtt') return 'vtt';
  if (n.endsWith('.txt') || mime === 'text/plain') return 'txt';
  return null;
}

export function mediaKindOf(name: string, mime: string): 'audio' | 'video' | null {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'webm', 'mkv', '3gp'].includes(ext)) return 'video';
  return null;
}

export function isImageFile(name: string, mime: string): boolean {
  if (mime.startsWith('image/')) return mime !== 'image/svg+xml';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif', 'bmp'].includes(ext);
}

/** Strip path components and control characters from a display name. */
export function safeFileName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, 120) || 'file';
}

export function isShareEnvelope(v: unknown): v is ShareEnvelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return e.version === 1 && typeof e.id === 'string' && typeof e.action === 'string';
}

/** Turn free text (e.g. "Check this out https://youtu.be/x") into capture requests. */
export function requestsFromText(text: string, subject?: string): CaptureRequest[] {
  const trimmed = text.slice(0, MAX_TEXT_CHARS).trim();
  if (!trimmed) return [];
  const urls = extractUrls(trimmed);
  const out: CaptureRequest[] = [];
  for (const raw of urls) {
    const info = analyzeUrl(raw);
    if (!info) continue;
    const surrounding = trimmed.replace(raw, '').trim();
    out.push({
      kind: 'url',
      url: info.url,
      sourceType: info.sourceType,
      dedupeKey: info.dedupeKey,
      title: subject?.trim() || undefined,
      // Keep text shared alongside a single link (e.g. a caption) as the user's note.
      note: urls.length === 1 && surrounding && surrounding !== subject?.trim() ? surrounding.slice(0, 5000) : undefined,
    });
  }
  if (out.length === 0) out.push({ kind: 'text', text: trimmed, title: subject?.trim() || undefined });
  return out;
}

export function normalizeShare(env: ShareEnvelope): NormalizedShare {
  const rejected = [...(env.errors ?? [])];
  const requests: CaptureRequest[] = [];
  const images: SharedFile[] = [];
  if (typeof env.text === 'string' && env.text.trim()) {
    requests.push(...requestsFromText(env.text, env.subject));
  }
  for (const f of env.files ?? []) {
    const name = safeFileName(String(f.name ?? ''));
    const mime = String(f.mime ?? '').toLowerCase();
    const size = Number(f.size);
    if (!f.path || !Number.isFinite(size) || size <= 0) {
      rejected.push({ name, reason: 'The shared file was empty or could not be read.' });
      continue;
    }
    const file: SharedFile = { path: f.path, name, mime, size };
    const tfmt = transcriptFormatOf(name, mime);
    const mkind = mediaKindOf(name, mime);
    if (tfmt) {
      if (size > MAX_TRANSCRIPT_BYTES) rejected.push({ name, reason: 'Transcript file is larger than 5 MB.' });
      else requests.push({ kind: 'transcript_file', file, format: tfmt });
    } else if (isImageFile(name, mime)) {
      if (size > MAX_IMAGE_BYTES) rejected.push({ name, reason: 'Image is larger than 30 MB.' });
      else images.push(file);
    } else if (mkind) {
      if (size > MAX_MEDIA_BYTES) rejected.push({ name, reason: 'Media file is larger than 200 MB.' });
      else requests.push({ kind: 'media_file', file, mediaKind: mkind });
    } else {
      rejected.push({ name, reason: `Unsupported file type (${mime || 'unknown'}).` });
    }
  }
  if (images.length) {
    // A caption shared with screenshots (no link) belongs to the image note rather than a separate item.
    const textIdx = requests.findIndex((r) => r.kind === 'text');
    const caption = textIdx >= 0 ? requests.splice(textIdx, 1)[0] : undefined;
    requests.push({
      kind: 'images', files: images,
      text: caption?.kind === 'text' ? caption.text : undefined,
      title: env.subject?.trim() || undefined,
    });
  }
  // Collapse duplicate links shared together.
  const seen = new Set<string>();
  const unique = requests.filter((r) => {
    if (r.kind !== 'url') return true;
    if (seen.has(r.dedupeKey)) return false;
    seen.add(r.dedupeKey);
    return true;
  });
  return { requests: unique, rejected };
}
