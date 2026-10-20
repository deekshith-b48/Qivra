/**
 * Transcript parsing and chunking. Mirrors server/qivra/transcripts.py.
 * Timestamps are kept only when the source provides them.
 */

export interface Segment {
  startMs: number | null;
  endMs: number | null;
  text: string;
}

export type TranscriptFormat = 'srt' | 'vtt' | 'txt';

export class TranscriptParseError extends Error {}

export const MAX_TRANSCRIPT_CHARS = 1_500_000;

const TS = String.raw`(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})`;
const CUE_RE = new RegExp(String.raw`^\s*${TS}\s*-->\s*${TS}`);
const CUE_ANYWHERE_RE = new RegExp(String.raw`^\s*${TS}\s*-->\s*${TS}`, 'm');
const INLINE_TS_RE = /^\s*[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–:]?\s+(.*)$/;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function ms(h: string | undefined, m: string, s: string, frac: string | undefined): number {
  const f = (frac ?? '0').padEnd(3, '0').slice(0, 3);
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f);
}

function clean(line: string): string {
  return line
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .trim();
}

function parseCues(text: string): Segment[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const segs: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = CUE_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const start = ms(m[1], m[2], m[3], m[4]);
    const end = ms(m[5], m[6], m[7], m[8]);
    i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !CUE_RE.test(lines[i])) {
      const c = clean(lines[i]);
      if (c) body.push(c);
      i++;
    }
    const txt = body.join(' ').trim();
    if (!txt) continue;
    const prev = segs[segs.length - 1];
    if (prev && prev.text === txt) prev.endMs = Math.max(prev.endMs ?? end, end);
    else segs.push({ startMs: start, endMs: Math.max(end, start), text: txt });
  }
  return segs;
}

export function parseSrt(text: string): Segment[] {
  const segs = parseCues(text);
  if (!segs.length) throw new TranscriptParseError('No SRT cues found.');
  return segs;
}

export function parseVtt(text: string): Segment[] {
  if (!text.replace(/^﻿/, '').trimStart().startsWith('WEBVTT')) throw new TranscriptParseError('Missing WEBVTT header.');
  const segs = parseCues(text);
  if (!segs.length) throw new TranscriptParseError('No WebVTT cues found.');
  return segs;
}

export function parseTxt(text: string): Segment[] {
  const segs: Segment[] = [];
  const plain: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = INLINE_TS_RE.exec(line);
    if (m) {
      const parts = m[1].split(':').map(Number);
      while (parts.length < 3) parts.unshift(0);
      const start = ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
      const prev = segs[segs.length - 1];
      if (prev && prev.endMs === null) prev.endMs = start;
      segs.push({ startMs: start, endMs: null, text: m[2].trim() });
    } else plain.push(line);
  }
  if (segs.length && segs.length >= Math.max(2, plain.length)) {
    const last = segs[segs.length - 1];
    if (last.endMs === null) last.endMs = last.startMs;
    return segs;
  }
  const joined = (segs.length ? [...segs.map((s) => s.text), ...plain] : plain).join('\n').trim();
  if (!joined) throw new TranscriptParseError('Transcript is empty.');
  return [{ startMs: null, endMs: null, text: joined }];
}

export function detectFormat(fileName: string | undefined, text: string): TranscriptFormat {
  const n = (fileName ?? '').toLowerCase();
  if (n.endsWith('.vtt') || text.replace(/^﻿/, '').trimStart().startsWith('WEBVTT')) return 'vtt';
  if (n.endsWith('.srt') || CUE_ANYWHERE_RE.test(text.slice(0, 2000))) return 'srt';
  return 'txt';
}

export function parseTranscript(text: string, format?: TranscriptFormat, fileName?: string): { format: TranscriptFormat; segments: Segment[] } {
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new TranscriptParseError('Transcript is too large.');
  const body = text.replace(/^﻿/, '');
  const fmt = format ?? detectFormat(fileName, body);
  const segments = fmt === 'srt' ? parseSrt(body) : fmt === 'vtt' ? parseVtt(body) : parseTxt(body);
  return { format: fmt, segments };
}

export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => s.text).join('\n');
}

export function hasTimestamps(segments: Segment[]): boolean {
  return segments.some((s) => s.startMs !== null);
}

export function formatTimestamp(msValue: number | null | undefined): string {
  if (msValue === null || msValue === undefined) return '';
  const total = Math.floor(msValue / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export interface Chunk {
  ordinal: number;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

/**
 * Split segments into retrieval chunks of roughly `target` characters, never
 * splitting a timed segment, so every chunk keeps a real timestamp range.
 * Untimed text is split on sentence boundaries.
 */
export function chunkSegments(segments: Segment[], target = 700): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (text: string, startMs: number | null, endMs: number | null) => {
    const t = text.trim();
    if (t) chunks.push({ ordinal: chunks.length, text: t, startMs, endMs });
  };
  let buf = '';
  let start: number | null = null;
  let end: number | null = null;
  for (const seg of segments) {
    if (seg.startMs === null) {
      if (buf) {
        push(buf, start, end);
        buf = '';
        start = end = null;
      }
      const sentences = seg.text.split(/(?<=[.!?。！？])\s+|\n+/);
      let acc = '';
      for (const s of sentences) {
        if (acc && acc.length + s.length > target) {
          push(acc, null, null);
          acc = '';
        }
        acc += (acc ? ' ' : '') + s;
      }
      push(acc, null, null);
      continue;
    }
    if (buf && buf.length + seg.text.length > target) {
      push(buf, start, end);
      buf = '';
      start = end = null;
    }
    if (start === null) start = seg.startMs;
    end = seg.endMs ?? seg.startMs;
    buf += (buf ? ' ' : '') + seg.text;
  }
  if (buf) push(buf, start, end);
  return chunks;
}
