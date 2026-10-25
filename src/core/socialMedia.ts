/**
 * Finding the video of a shared X post on the phone (pure, unit-tested), through the
 * public syndication endpoint that X's own embedded posts use. Only video URLs on X's
 * own CDN are accepted. (Instagram serves reels only to its own app and site.)
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
