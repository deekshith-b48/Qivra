/**
 * URL normalisation, source detection and duplicate keys.
 * Ported from SuperBrain `backend/core/link_checker.py` (Instagram/YouTube/web
 * detection) and `superbrain-app/src/services/urlUtils.ts` (platform names),
 * extended with GitHub and podcast detection.
 */

export type SourceType = 'youtube' | 'instagram' | 'x' | 'github' | 'podcast' | 'web' | 'note' | 'file' | 'text';

/** Short-form/long-form video platforms whose speech Qivra transcribes. */
export const VIDEO_SOURCES: SourceType[] = ['youtube', 'instagram', 'x', 'podcast'];
export const WEBSITE_SOURCES: SourceType[] = ['web', 'github'];
export const NOTE_SOURCES: SourceType[] = ['note', 'text', 'file'];
/** Transcript-table sources that hold article/README text rather than speech. */
export const ARTICLE_SOURCES = new Set(['web_article', 'github_readme']);

export const SOURCE_LABELS: Record<SourceType, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  x: 'X',
  github: 'GitHub',
  podcast: 'Podcast',
  web: 'Web',
  note: 'Note',
  file: 'File',
  text: 'Text',
};

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'igshid', 'igsh', 'si', 'feature', 'ref', 'ref_src', 'ref_url', 'mc_cid', 'mc_eid',
  'spm', 'share_id', 'utm_id', '_ga', 'yclid', 'mkt_tok',
]);

const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s<>"'`\])}]+/gi;

export interface UrlInfo {
  url: string; // normalised URL used for display and fetching
  sourceType: SourceType;
  dedupeKey: string;
  youtubeId?: string;
  instagramShortcode?: string;
  xStatusId?: string;
  githubRepo?: string; // owner/name
  host: string;
}

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_IN_TEXT_RE)) {
    const cleaned = m[0].replace(/[.,;:!?]+$/, '');
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

function stripWww(host: string): string {
  return host.replace(/^www\./, '').replace(/^m\./, '');
}

export function youtubeIdOf(u: URL): string | undefined {
  const host = stripWww(u.hostname.toLowerCase());
  let id: string | null | undefined;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
      id = m?.[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : undefined;
}

export function instagramShortcodeOf(u: URL): string | undefined {
  if (stripWww(u.hostname.toLowerCase()) !== 'instagram.com') return undefined;
  const m = /^\/(?:[A-Za-z0-9_.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  return m?.[1];
}

/** x.com / twitter.com status links → status id. */
export function xStatusIdOf(u: URL): string | undefined {
  const host = stripWww(u.hostname.toLowerCase());
  if (!['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com', 'fxtwitter.com', 'vxtwitter.com'].includes(host)) return undefined;
  const m = /^\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/.exec(u.pathname);
  return m?.[1];
}

const GITHUB_RESERVED = new Set([
  'about', 'features', 'pricing', 'login', 'join', 'settings', 'marketplace', 'explore', 'topics', 'trending',
  'orgs', 'sponsors', 'notifications', 'search', 'collections', 'events', 'apps', 'enterprise', 'site',
]);

export function githubRepoOf(u: URL): string | undefined {
  if (stripWww(u.hostname.toLowerCase()) !== 'github.com') return undefined;
  const [owner, repo] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo || GITHUB_RESERVED.has(owner.toLowerCase())) return undefined;
  const name = repo.replace(/\.+$/, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return undefined;
  return `${owner}/${name}`;
}

function isPodcast(u: URL): boolean {
  const host = stripWww(u.hostname.toLowerCase());
  return (
    (host === 'open.spotify.com' && /^\/(episode|show)\//.test(u.pathname)) ||
    host === 'podcasts.apple.com' ||
    host === 'pca.st' ||
    host === 'pocketcasts.com' ||
    host === 'overcast.fm' ||
    host === 'castbox.fm' ||
    host === 'podcasts.google.com'
  );
}

/** Normalise and classify a URL. Returns null for anything that is not http(s). */
export function analyzeUrl(raw: string): UrlInfo | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }

  const yt = youtubeIdOf(u);
  if (yt) {
    const url = `https://www.youtube.com/watch?v=${yt}`;
    return { url, sourceType: 'youtube', dedupeKey: `youtube:${yt}`, youtubeId: yt, host: 'youtube.com' };
  }
  const ig = instagramShortcodeOf(u);
  if (ig) {
    const kind = /\/(reel|reels)\//.test(u.pathname) ? 'reel' : 'p';
    return {
      url: `https://www.instagram.com/${kind}/${ig}/`,
      sourceType: 'instagram',
      dedupeKey: `instagram:${ig}`,
      instagramShortcode: ig,
      host: 'instagram.com',
    };
  }
  const xs = xStatusIdOf(u);
  if (xs) {
    const user = /^\/([A-Za-z0-9_]{1,15})\/status/.exec(u.pathname)?.[1];
    const url = `https://x.com/${user && user !== 'i' ? user : 'i'}/status/${xs}`;
    return { url, sourceType: 'x', dedupeKey: `x:${xs}`, xStatusId: xs, host: 'x.com' };
  }
  const gh = githubRepoOf(u);
  if (gh) {
    const rest = u.pathname.split('/').filter(Boolean).slice(2).join('/');
    const url = `https://github.com/${gh}${rest ? `/${rest}` : ''}`;
    return { url, sourceType: 'github', dedupeKey: `github:${gh.toLowerCase()}${rest ? `/${rest}` : ''}`, githubRepo: gh, host: 'github.com' };
  }
  let path = u.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/' && path.endsWith('/index.html')) path = path.slice(0, -'/index.html'.length) || '/';
  const query = u.searchParams.toString();
  const url = `${u.protocol}//${u.host}${path === '/' ? '' : path}${query ? `?${query}` : ''}`;
  const keyHost = stripWww(u.host);
  return {
    url,
    sourceType: isPodcast(u) ? 'podcast' : 'web',
    dedupeKey: `url:${keyHost}${path === '/' ? '' : path}${query ? `?${query}` : ''}`,
    host: keyHost,
  };
}

export function platformName(url: string): string {
  const info = analyzeUrl(url);
  if (!info) return 'Link';
  if (info.sourceType !== 'web') return SOURCE_LABELS[info.sourceType];
  const parts = info.host.split('.');
  const root = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : 'Web';
}
