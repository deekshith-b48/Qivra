/**
 * yt-dlp on the phone (youtubedl-android, see plugins/android/QivraDownloaderModule.kt), used only to get the
 * audio of a public Instagram reel for transcription. Not available in Jest or Expo Go.
 */

import * as FS from 'expo-file-system/legacy';
import { NativeModules } from 'react-native';
import { classifyYtdlpError, parseYtdlpInfo, type YtdlpInfo } from '../core/ytdlp';
import { getRepo } from './db';

interface Native {
  downloadAudio(url: string, maxMb: number): Promise<string>;
  update(): Promise<string>;
  version(): Promise<string>;
}
const native = () => (NativeModules.QivraDownloader as Native | undefined) ?? null;

export class DownloadError extends Error {
  constructor(public code: 'UNAVAILABLE' | 'BLOCKED' | 'OFFLINE' | 'TOO_LARGE' | 'FAILED', message: string) {
    super(message);
  }
}

// The yt-dlp bundled with the library goes stale as Instagram changes, so it is updated weekly before a
// download, and right away (at most hourly) when a download is refused, then the download is tried once more.
const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;
const UPDATED_KEY = 'ytdlp.updatedAt';

async function freshen(n: Native, refused: boolean): Promise<boolean> {
  const repo = await getRepo();
  const age = Date.now() - Number((await repo.getMeta(UPDATED_KEY)) ?? 0);
  if (age < (refused ? HOUR_MS : WEEK_MS)) return false;
  try {
    await n.update();
    await repo.setMeta(UPDATED_KEY, String(Date.now()));
    return true;
  } catch {
    return false; // offline or GitHub unreachable: use the yt-dlp we have
  }
}

/** Downloads a reel's audio into the cache (the caller deletes it). `uri` is a file:// URI. */
export async function downloadReelAudio(url: string, maxMb = 24): Promise<YtdlpInfo & { uri: string }> {
  const n = native();
  if (!n) throw new DownloadError('UNAVAILABLE', 'The video downloader is not part of this build.');
  await freshen(n, false);
  let out: string;
  try {
    out = await n.downloadAudio(url, maxMb).catch(async (e: Error) => {
      if (classifyYtdlpError(e?.message ?? '') === 'OFFLINE' || !(await freshen(n, true))) throw e;
      return n.downloadAudio(url, maxMb);
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    const kind = classifyYtdlpError(msg);
    if (kind === 'BLOCKED') throw new DownloadError('BLOCKED', 'Instagram blocked this download (it asks apps to sign in, or the reel is private). Try again later.');
    if (kind === 'OFFLINE') throw new DownloadError('OFFLINE', 'No internet connection.');
    throw new DownloadError('FAILED', `The reel could not be downloaded${msg ? `: ${msg.replace(/^.*ERROR:\s*/s, '').slice(0, 160)}` : '.'}`);
  }
  const info = parseYtdlpInfo(out);
  const uri = info ? (info.path.startsWith('file://') ? info.path : `file://${info.path}`) : '';
  // yt-dlp skips files over --max-filesize without failing.
  if (!info || !(await FS.getInfoAsync(uri)).exists) throw new DownloadError('TOO_LARGE', `This reel's audio is over ${maxMb} MB, more than Groq accepts. Import a transcript instead.`);
  return { ...info, uri };
}

/** Updates yt-dlp (when a site changes and downloads start failing). Returns a status line. */
export async function updateDownloader(): Promise<string> {
  const n = native();
  if (!n) throw new DownloadError('UNAVAILABLE', 'The video downloader is not part of this build.');
  const status = await n.update();
  await (await getRepo()).setMeta(UPDATED_KEY, String(Date.now()));
  return status;
}

export async function downloaderVersion(): Promise<string | null> {
  return (await native()?.version().catch(() => null)) ?? null;
}
