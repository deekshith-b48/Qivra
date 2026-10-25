/**
 * Reading yt-dlp's output (pure, unit-tested). The native side (plugins/android/QivraDownloaderModule.kt)
 * runs yt-dlp with `-j --no-simulate`, which prints the post's info JSON and downloads its audio.
 */

export interface YtdlpInfo {
  path: string;
  mime: string;
  title: string | null;
  description: string | null;
  durationMs: number | null;
}

const MIME: Record<string, string> = { m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'audio/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg' };

/** The downloaded file and post details from yt-dlp's stdout, or null when it printed no info line. */
export function parseYtdlpInfo(stdout: string): YtdlpInfo | null {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const dl = Array.isArray(j.requested_downloads) ? (j.requested_downloads[0] as Record<string, unknown> | undefined) : undefined;
  const path = [dl?.filepath, j.filename, j._filename].find((x): x is string => typeof x === 'string' && x.length > 0);
  if (!path) return null;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  return {
    path,
    mime: MIME[ext] ?? 'video/mp4',
    title: str(j.title),
    description: str(j.description),
    durationMs: typeof j.duration === 'number' && Number.isFinite(j.duration) ? Math.round(j.duration * 1000) : null,
  };
}

export type YtdlpFailure = 'BLOCKED' | 'OFFLINE' | 'FAILED';

/** What a yt-dlp error means for the user: the site refused (sign-in, rate limit, private), no internet, or something else. */
export function classifyYtdlpError(message: string): YtdlpFailure {
  if (/log ?in|sign ?in|cookies|rate.?limit|private|not available|unavailable|HTTP Error (401|403|429)|restricted/i.test(message)) return 'BLOCKED';
  if (/getaddrinfo|Network is unreachable|Temporary failure in name resolution|timed out|Connection (refused|reset|aborted)|No address associated|Unable to download webpage/i.test(message)) return 'OFFLINE';
  return 'FAILED';
}
