/**
 * Finding the video of a shared X or Instagram post on the phone (pure, unit-tested),
 * so it can be transcribed without a laptop server.
 *
 * - X: the public syndication endpoint that X's own embedded posts use.
 * - Instagram: only the public embed page (`/p/<code>/embed/captioned/`). No login,
 *   no private API. When the page offers no video, the caption is still used.
 * Only video URLs on each service's own CDN are accepted.
 */

/** Token X's embed widget sends with a post id (derived from the id itself). */
export function xSyndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function xSyndicationUrl(id: string): string {
  return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&lang=en&token=${xSyndicationToken(id)}`;
}

const X_VIDEO_HOST = /^https:\/\/video\.twimg\.com\//;

/** The smallest MP4 of the post's first video (audio is all a transcript needs), or null. */
export function pickXVideo(json: unknown): { url: string; durationMs: number | null } | null {
  const media = (json as { mediaDetails?: unknown })?.mediaDetails;
  if (!Array.isArray(media)) return null;
  for (const m of media) {
    const info = (m as { type?: string; video_info?: { duration_millis?: number; variants?: { content_type?: string; bitrate?: number; url?: string }[] } });
    if (info.type !== 'video' && info.type !== 'animated_gif') continue;
    const mp4 = (info.video_info?.variants ?? [])
      .filter((v) => v.content_type === 'video/mp4' && typeof v.url === 'string' && X_VIDEO_HOST.test(v.url))
      .sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
    if (mp4.length) return { url: mp4[0].url!, durationMs: info.video_info?.duration_millis ?? null };
  }
  return null;
}

export function instagramEmbedUrl(shortcode: string): string {
  return `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`;
}

const IG_VIDEO_HOST = /^https:\/\/[a-z0-9.-]*\.(cdninstagram\.com|fbcdn\.net)\//i;

const decodeJsonString = (s: string): string => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return '';
  }
};

const decodeHtml = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** Video URL and caption from Instagram's public embed page, when it offers them. */
export function parseInstagramEmbed(html: string): { videoUrl: string | null; caption: string | null } {
  let videoUrl: string | null = null;
  const fromJson = html.match(/\\?"video_url\\?"\s*:\s*\\?"((?:[^"\\]|\\.)+?)\\?"/);
  const candidates = [
    fromJson ? decodeJsonString(fromJson[1].replace(/\\\\/g, '\\')) : '',
    decodeHtml(html.match(/<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"/i)?.[1] ?? ''),
    decodeHtml(html.match(/<video[^>]+src="([^"]+)"/i)?.[1] ?? ''),
  ];
  for (const c of candidates) {
    const url = c.replace(/\\\//g, '/');
    if (IG_VIDEO_HOST.test(url)) {
      videoUrl = url;
      break;
    }
  }
  // The caption block: <div class="Caption"> … <a class="CaptionUsername">user</a> text … <div class="CaptionComments">
  const block = html.match(/<div class="Caption">([\s\S]*?)<div class="CaptionComments"/i)?.[1] ?? '';
  const caption = decodeHtml(
    block.replace(/<a[^>]*class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/i, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''),
  ).split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  return { videoUrl, caption: caption || null };
}
