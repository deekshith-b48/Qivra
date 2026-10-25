/**
 * YouTube captions fetched directly on the phone.
 *
 * Uses the public player endpoint (the same one YouTube's Android app uses) to
 * list the caption tracks YouTube publishes for a video, then downloads one
 * track in timed-text format 3 (`<p t="ms" d="ms">text</p>`). Only captions
 * YouTube itself serves are used — no media is downloaded.
 */

import { decodeEntities } from './metadata';
import type { Segment } from './transcripts';

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind: 'manual' | 'asr';
  name: string;
}

export interface CaptionResult {
  language: string;
  kind: 'manual' | 'asr';
  trackName: string;
  segments: Segment[];
  /** Set when YouTube translated the track (tlang): the track's own language. */
  translatedFrom?: string;
}

export class CaptionsUnavailable extends Error {
  constructor(public code: 'NO_TRACKS' | 'UNPLAYABLE' | 'HTTP' | 'EMPTY', message: string) {
    super(message);
  }
}

const CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' };
const UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';

const langOf = (t: CaptionTrack) => t.languageCode.toLowerCase().split('-')[0];

/**
 * The track to download: a manual track in a preferred language (English), else auto-generated captions in
 * it ("English (auto-generated)"), else the video's own auto-captions (its spoken language, which
 * fetchYouTubeCaptions then asks YouTube to translate), else any manual track.
 */
export function chooseTrack(tracks: CaptionTrack[], preferred: string[] = ['en']): CaptionTrack | null {
  for (const p of preferred.map((x) => x.toLowerCase().split('-')[0])) {
    const hit = tracks.find((t) => t.kind === 'manual' && langOf(t) === p) ?? tracks.find((t) => t.kind === 'asr' && langOf(t) === p);
    if (hit) return hit;
  }
  const asr = tracks.find((t) => t.kind === 'asr');
  if (asr) return tracks.find((t) => t.kind === 'manual' && langOf(t) === langOf(asr)) ?? asr;
  return tracks[0] ?? null;
}

/** Parse YouTube timed-text XML (format 3 `<p t d>`, or legacy `<text start dur>`) into segments. */
export function parseTimedText(xml: string): Segment[] {
  const segs: Segment[] = [];
  if (!/<p\s/.test(xml)) {
    for (const m of xml.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/g)) {
      const start = Math.round(Number(/\bstart="([\d.]+)"/.exec(m[1])?.[1] ?? Number.NaN) * 1000);
      const dur = Math.round(Number(/\bdur="([\d.]+)"/.exec(m[1])?.[1] ?? 0) * 1000);
      const text = decodeEntities(decodeEntities(m[2]).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      if (Number.isFinite(start) && text) segs.push({ startMs: start, endMs: start + dur, text });
    }
    return segs;
  }
  for (const m of xml.matchAll(/<p\s+([^>]*)>([\s\S]*?)<\/p>/g)) {
    const attrs = m[1];
    const t = Number(/\bt="(\d+)"/.exec(attrs)?.[1] ?? Number.NaN);
    const d = Number(/\bd="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(t) || !text) continue;
    const prev = segs[segs.length - 1];
    if (prev && prev.text === text) {
      prev.endMs = Math.max(prev.endMs ?? t, t + d);
      continue;
    }
    segs.push({ startMs: t, endMs: t + d, text });
  }
  return segs;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl: string; languageCode: string; kind?: string; name?: { runs?: { text: string }[]; simpleText?: string } }[] } };
}

/** The public player response (the same request the YouTube Android app makes; no login). */
async function fetchPlayer(videoId: string, fetchImpl: FetchLike): Promise<PlayerResponse> {
  const res = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ context: { client: CLIENT }, videoId }),
  });
  if (!res.ok) throw new CaptionsUnavailable('HTTP', `YouTube returned HTTP ${res.status}.`);
  return JSON.parse(await res.text()) as PlayerResponse;
}

export async function listCaptionTracks(videoId: string, fetchImpl: FetchLike): Promise<CaptionTrack[]> {
  const j = await fetchPlayer(videoId, fetchImpl);
  const status = j.playabilityStatus?.status;
  if (status && status !== 'OK') throw new CaptionsUnavailable('UNPLAYABLE', j.playabilityStatus?.reason ?? `Video is not available (${status}).`);
  const tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return tracks
    .filter((t) => typeof t.baseUrl === 'string' && t.baseUrl.startsWith('https://'))
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind === 'asr' ? 'asr' : 'manual',
      name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? t.languageCode,
    }));
}

export async function fetchYouTubeCaptions(videoId: string, fetchImpl: FetchLike, preferredLanguages: string[] = ['en']): Promise<CaptionResult> {
  const tracks = await listCaptionTracks(videoId, fetchImpl);
  const track = chooseTrack(tracks, preferredLanguages);
  if (!track) throw new CaptionsUnavailable('NO_TRACKS', 'This video has no captions on YouTube.');
  const url = `${track.baseUrl.replace(/&fmt=[^&]*/, '').replace(/&tlang=[^&]*/, '')}&fmt=srv3`;
  const want = preferredLanguages[0]?.toLowerCase().split('-')[0];
  // Not in the wanted language: YouTube's own auto-translate ("Auto-translate → English" in its player).
  if (want && langOf(track) !== want) {
    const tr = await fetchImpl(`${url}&tlang=${want}`, { headers: { 'User-Agent': UA } }).catch(() => null);
    const segments = tr?.ok ? parseTimedText(await tr.text()) : [];
    if (segments.length) return { language: want, kind: track.kind, trackName: track.name, segments, translatedFrom: langOf(track) };
  }
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new CaptionsUnavailable('HTTP', `Caption download failed (HTTP ${res.status}).`);
  const segments = parseTimedText(await res.text());
  if (!segments.length) throw new CaptionsUnavailable('EMPTY', 'YouTube returned an empty caption track.');
  return { language: langOf(track), kind: track.kind, trackName: track.name, segments };
}
