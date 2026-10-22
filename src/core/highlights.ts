/**
 * Keyword highlights for a video/article page: the terms that matter most in
 * this item and the exact moments (timestamps) where they occur. Computed from
 * the transcript itself, so every highlight is backed by source text.
 */

import { stripUrls, tokenize } from './enrich';
import type { Segment } from './transcripts';

export interface KeywordMoment {
  startMs: number | null;
  text: string;
}

export interface Keyword {
  term: string;
  count: number;
  isTool: boolean;
  moments: KeywordMoment[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termRegex(term: string, flags = 'gi'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(term)}(?![\\p{L}\\p{N}])`, flags.includes('u') ? flags : `${flags}u`);
}

export function countTerm(text: string, term: string): number {
  return text.match(termRegex(term))?.length ?? 0;
}

// Spoken filler and generic words that make poor highlights even when frequent.
const FILLER = new Set(
  `really gonna wanna gotta video videos guys actually thing things people basically literally kind sort stuff pretty
something anything everything nothing someone everyone maybe probably definitely obviously honestly totally simply
just like good great nice cool awesome amazing super much many lots little bit able sure well even still back
time times today right left look looking looks lets need needs needed said says say saying talk talking tell
mean means start started going come comes coming give take put keep makes making work works working first last
next new different same whole every always never ever again already actually channel subscribe click link
watch watching comment comments episode part here there where yeah yes okay hello welcome thanks`.split(/\s+/),
);

const meaningful = (w: string) => w.length >= 3 && !FILLER.has(w) && !/[./]/.test(w) && !/^\d/.test(w);

/** Words of `text` in order, lowercased, with stopwords removed in place (so bigrams never jump over them). */
function words(text: string): (string | null)[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.'-]*/g) ?? []).map((raw) => {
    const w = raw.replace(/[.'-]+$/, '');
    const kept = tokenize(w);
    return kept.length === 1 && kept[0] === w && meaningful(w) ? w : null;
  });
}

export function extractKeywords(
  segments: Segment[],
  opts: { tools?: string[]; title?: string; max?: number; concepts?: string[] } = {},
): Keyword[] {
  const max = opts.max ?? 8;
  // Web addresses are not words of the content ("github" in every link is not a topic).
  segments = segments.map((s) => ({ ...s, text: stripUrls(s.text) }));
  const full = segments.map((s) => s.text).join(' ');
  if (!full.trim()) return [];
  const candidates = new Map<string, { count: number; isTool: boolean }>();
  // Whole-word containment: "claude code" contains "claude", not "code review".
  const within = (outer: string, inner: string) => ` ${outer.toLowerCase()} `.includes(` ${inner.toLowerCase()} `);
  const related = (term: string) => [...candidates.entries()].filter(([k]) => within(k, term) || within(term, k));
  const overlaps = (term: string) => related(term).length > 0;
  // Tools take at most half the slots, most-mentioned first, so the item's own topics still show.
  const tools = (opts.tools ?? []).map((t) => ({ t, n: countTerm(full, t) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  for (const { t, n } of tools.slice(0, Math.ceil(max / 2))) candidates.set(t, { count: n, isTool: true });
  // Model concepts are copied from the source; keep only those that really occur here.
  for (const concept of opts.concepts ?? []) {
    if (candidates.size >= max) break;
    if (/[./\\]|--/.test(concept)) continue; // file names, paths and flags ("video.mp4", "--device") are not topics
    const n = countTerm(full, concept);
    if (n > 0 && !overlaps(concept)) candidates.set(concept, { count: n, isTool: false });
  }
  if (candidates.size < max) {
    const titleTerms = new Set(tokenize(opts.title ?? ''));
    const uni = new Map<string, number>();
    const bi = new Map<string, number>();
    for (const seg of segments) {
      const ws = words(seg.text);
      ws.forEach((w, i) => {
        if (!w) return;
        uni.set(w, (uni.get(w) ?? 0) + 1);
        const nx = ws[i + 1];
        if (nx && nx !== w) bi.set(`${w} ${nx}`, (bi.get(`${w} ${nx}`) ?? 0) + 1);
      });
    }
    const boost = (t: string) => (t.split(' ').some((w) => titleTerms.has(w)) ? 2 : 1);
    const ranked = [
      // A keyword must recur in the content itself; title terms only get a ranking boost.
      ...[...bi.entries()].filter(([, n]) => n >= 2).map(([t, n]) => ({ t, n, score: n * boost(t) * 1.5 * Math.log(2 + t.length) })),
      ...[...uni.entries()].filter(([w, n]) => n >= 2 && w.length >= 4).map(([t, n]) => ({ t, n, score: n * boost(t) * Math.log(2 + t.length) })),
    ].sort((a, b) => b.score - a.score);
    for (const r of ranked) {
      if (candidates.size >= max) break;
      const rel = related(r.t);
      // A word that mostly appears inside an already-chosen phrase adds nothing.
      if (rel.length && (r.t.includes(' ') || r.n < 2 * Math.max(...rel.map(([, v]) => v.count)))) continue;
      candidates.set(r.t, { count: r.n, isTool: false });
    }
  }
  // Untimed text (articles, posts) is split into sentences so a "moment" is the sentence that mentions the term.
  const momentSegs: Segment[] = segments.flatMap((s) =>
    s.startMs === null ? s.text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((t) => ({ startMs: null, endMs: null, text: t.trim() })).filter((t) => t.text) : [s],
  );
  return [...candidates.entries()]
    .map(([term, v]) => ({
      term,
      count: v.count,
      isTool: v.isTool,
      moments: momentSegs
        .filter((s) => countTerm(s.text, term) > 0)
        .slice(0, 6)
        .map((s) => ({ startMs: s.startMs, text: s.text.length > 200 ? `${s.text.slice(0, 197)}…` : s.text })),
    }))
    .sort((a, b) => Number(b.isTool) - Number(a.isTool) || b.count - a.count)
    .slice(0, max);
}

export interface Span {
  text: string;
  hit: boolean;
}

/** Split text into spans, marking every occurrence of any term (case-insensitive, whole words). */
export function splitHighlights(text: string, terms: string[]): Span[] {
  const clean = terms.filter((t) => t.trim().length > 1).sort((a, b) => b.length - a.length);
  if (!clean.length || !text) return [{ text, hit: false }];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${clean.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}
