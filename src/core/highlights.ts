/**
 * Keyword highlights for a video/article page: the terms that matter most in
 * this item and the exact moments (timestamps) where they occur. Computed from
 * the transcript itself, so every highlight is backed by source text.
 */

import { tokenize } from './enrich';
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

export function extractKeywords(segments: Segment[], opts: { tools?: string[]; title?: string; max?: number } = {}): Keyword[] {
  const max = opts.max ?? 10;
  const full = segments.map((s) => s.text).join(' ');
  if (!full.trim()) return [];
  const candidates = new Map<string, { count: number; isTool: boolean }>();
  for (const tool of opts.tools ?? []) {
    const n = countTerm(full, tool);
    if (n > 0) candidates.set(tool, { count: n, isTool: true });
  }
  const titleTerms = new Set(tokenize(opts.title ?? ''));
  const counts = new Map<string, number>();
  for (const w of tokenize(full)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const toolWords = new Set([...candidates.keys()].flatMap((t) => t.toLowerCase().split(/\s+/)));
  const ranked = [...counts.entries()]
    // A keyword must recur in the content itself; title terms only get a ranking boost.
    .filter(([w, n]) => w.length >= 4 && !toolWords.has(w) && n >= 2 && !/[./]/.test(w))
    .map(([w, n]) => ({ w, n, score: n * (titleTerms.has(w) ? 2 : 1) * Math.log(2 + w.length) }))
    .sort((a, b) => b.score - a.score);
  for (const r of ranked) {
    if (candidates.size >= max) break;
    candidates.set(r.w, { count: r.n, isTool: false });
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
