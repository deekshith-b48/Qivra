/**
 * Permitted, public metadata only:
 *  - YouTube: the public oEmbed endpoint (title, channel, thumbnail).
 *  - GitHub: the public REST API (description, topics, language, stars) and README text.
 *  - Web pages: <title> and Open Graph tags from the page HTML.
 *  - Instagram: nothing is fetched (oEmbed needs an app token; we do not scrape).
 * No audio/video is downloaded and no access control is bypassed.
 */

import type { UrlInfo } from './url';

export interface FetchedMetadata {
  title: string;
  description: string;
  author: string;
  siteName: string;
  imageUrl: string;
  bodyText: string; // e.g. GitHub README text, used for local extraction
  provider: string;
}

type FetchText = (url: string, opts: { accept: string; timeoutMs: number }) => Promise<{ ok: boolean; status: number; text: string; contentType: string }>;

const MAX_HTML = 1_500_000;

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function parseHtmlMeta(html: string, baseUrl: string): Omit<FetchedMetadata, 'bodyText' | 'provider'> {
  const head = html.slice(0, 300_000);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && content !== undefined && !(key in meta)) meta[key] = decodeEntities(content).trim();
  }
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let image = meta['og:image'] || meta['twitter:image'] || '';
  if (image) {
    try {
      image = new URL(image, baseUrl).toString();
    } catch {
      image = '';
    }
  }
  return {
    title: (meta['og:title'] || meta['twitter:title'] || title).slice(0, 300),
    description: (meta['og:description'] || meta.description || meta['twitter:description'] || '').slice(0, 1000),
    author: (meta.author || '').slice(0, 120),
    siteName: (meta['og:site_name'] || '').slice(0, 120),
    imageUrl: /^https:\/\//.test(image) ? image : '',
  };
}

/** HTML fragment → plain text with paragraph breaks. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

/**
 * Readable article text from a web page: drops scripts, navigation, headers,
 * footers and asides, prefers <article>/<main>, keeps headings, paragraphs,
 * list items and code blocks. Not a full Readability port, but enough to
 * summarise and search typical articles and docs.
 */
export function extractReadableText(html: string, maxChars = 60_000): string {
  let body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const scoped = /<article\b[\s\S]*?<\/article>/i.exec(body)?.[0] ?? /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (scoped && scoped.length > 500) body = scoped;
  const blocks: string[] = [];
  for (const m of body.matchAll(/<(h[1-3]|p|li|pre|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const text = htmlToText(m[2]).replace(/\[(\d+|citation needed|edit)\]/gi, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // Stop at back-matter: references, bibliographies and link lists are not the article.
    if (tag.startsWith('h') && /^(references|notes|citations|sources|bibliography|further reading|external links|see also|footnotes)$/i.test(text)) break;
    if (tag === 'li' && (/(doi:|isbn|retrieved |archived from|^\^)/i.test(text) || text.split(/\s+/).length < 4)) continue;
    if (tag.startsWith('h') && /^contents$/i.test(text)) continue;
    if (tag === 'p' && text.length < 25 && !/[.!?]$/.test(text)) continue;
    blocks.push(tag.startsWith('h') ? `${text}` : tag === 'li' ? `• ${text}` : text);
  }
  const out = blocks.join('\n\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, '')) // keep code (commands) but drop fences
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/(\*\*|__)/g, '')
    .replace(/^\s*>\s?(\[![A-Z]+\]\s*)?/gm, '')
    .replace(/\[![A-Z]+\]\s*/g, '')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)!?]|$)/g, '$1$2')
    .trim();
}

export async function fetchMetadata(info: UrlInfo, fetchText: FetchText): Promise<FetchedMetadata | null> {
  const empty: FetchedMetadata = { title: '', description: '', author: '', siteName: '', imageUrl: '', bodyText: '', provider: '' };
  if (info.sourceType === 'instagram') return null;
  if (info.sourceType === 'youtube') {
    const r = await fetchText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(info.url)}`, { accept: 'application/json', timeoutMs: 8000 });
    if (!r.ok) return null;
    const j = JSON.parse(r.text) as { title?: string; author_name?: string; thumbnail_url?: string };
    return { ...empty, title: j.title ?? '', author: j.author_name ?? '', siteName: 'YouTube', imageUrl: j.thumbnail_url?.startsWith('https://') ? j.thumbnail_url : '', provider: 'youtube-oembed' };
  }
  if (info.sourceType === 'github' && info.githubRepo) {
    const r = await fetchText(`https://api.github.com/repos/${info.githubRepo}`, { accept: 'application/vnd.github+json', timeoutMs: 8000 });
    if (!r.ok) return null;
    const j = JSON.parse(r.text) as { full_name?: string; description?: string; topics?: string[]; language?: string; stargazers_count?: number; owner?: { login?: string } };
    let readme = '';
    const rr = await fetchText(`https://api.github.com/repos/${info.githubRepo}/readme`, { accept: 'application/vnd.github.raw', timeoutMs: 8000 }).catch(() => null);
    if (rr?.ok) readme = stripMarkdown(rr.text).slice(0, 60_000);
    const facts = [j.language ? `Language: ${j.language}` : '', j.topics?.length ? `Topics: ${j.topics.join(', ')}` : '', typeof j.stargazers_count === 'number' ? `Stars: ${j.stargazers_count}` : ''].filter(Boolean).join('. ');
    return {
      ...empty, title: j.full_name ?? info.githubRepo, description: [j.description ?? '', facts].filter(Boolean).join(' — '),
      author: j.owner?.login ?? '', siteName: 'GitHub', bodyText: readme, provider: 'github-api',
    };
  }
  if (info.sourceType === 'x') {
    // X's public oEmbed endpoint returns the post text as a small HTML blockquote.
    const r = await fetchText(`https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(info.url)}`, { accept: 'application/json', timeoutMs: 8000 });
    if (!r.ok) return { ...empty, siteName: 'X', provider: 'x-oembed-unavailable' };
    const j = JSON.parse(r.text) as { author_name?: string; html?: string };
    const text = htmlToText((j.html ?? '').replace(/&mdash;[\s\S]*$/, '')).replace(/\s*(https?:\/\/)?pic\.(twitter|x)\.com\/\S+/g, '').replace(/\s*https?:\/\/t\.co\/\S+/g, '').trim();
    return { ...empty, title: text.slice(0, 140), description: text, author: j.author_name ?? '', siteName: 'X', bodyText: text, provider: 'x-oembed' };
  }
  const r = await fetchText(info.url, { accept: 'text/html,application/xhtml+xml', timeoutMs: 10_000 });
  if (!r.ok || !/html/i.test(r.contentType) || r.text.length > MAX_HTML) return null;
  const meta = parseHtmlMeta(r.text, info.url);
  return { ...meta, bodyText: info.sourceType === 'web' ? extractReadableText(r.text) : '', provider: 'html-meta' };
}
