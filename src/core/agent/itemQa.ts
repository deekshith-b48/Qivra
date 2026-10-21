/**
 * "Ask this item": questions about ONE saved video, post or page.
 *
 * The model sees that item's transcript with `[mm:ss]` markers (or its article
 * text) inside a neutralised <source> block, and must cite moments by those
 * markers. Every cited time is snapped to a real segment start or dropped, so
 * citations always point at real moments. Without a model, the best-matching
 * passages are returned with their timestamps.
 */

import type { ChatMessage, ChatProvider } from '../ai/provider';
import { marker, parseMarker, type TimedLine, timedTranscript, validStart } from '../enrichModel';
import { tokenize } from '../enrich';
import { neutralise, SYSTEM_RULES } from './guard';

export interface ItemQaSource {
  title: string;
  url: string | null;
  summary: string;
  note: string;
  /** Transcript lines; timed when the item has timestamps. */
  timed: TimedLine[];
  /** Article/README/post text for items without a timed transcript. */
  body: string;
}

export interface ItemQaMoment {
  sid: string;
  startMs: number | null;
  quote: string;
}

export interface ItemQaResult {
  mode: 'model' | 'retrieval_only' | 'no_evidence';
  answer: string;
  moments: ItemQaMoment[];
  provider: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}

const BODY_BUDGET = 14000;
const MARKER_RE = /\[(?:\d+:)?\d{1,3}:\d{2}\]/g;

export const ITEM_SUGGESTIONS = [
  'Summarise this in 5 bullet points.',
  'What tools, steps or commands are mentioned?',
  'Make a checklist I can follow.',
  'What are the main claims, and what evidence is given?',
];

const ITEM_RULES = `${SYSTEM_RULES}
7. You are answering about ONE saved item. When the source has [mm:ss] markers, cite moments by copying the marker exactly, e.g. [01:23]. Otherwise cite [S1].
8. Answer like a helpful modern assistant: a direct answer first, then short bullets or ## headings only where they help. Markdown, no padding.`;

function segmentsOf(src: ItemQaSource): { startMs: number; text: string }[] {
  return src.timed.filter((t): t is { startMs: number; text: string } => t.startMs !== null && !!t.text.trim());
}

export function itemQaMessages(src: ItemQaSource, question: string, history: { role: 'user' | 'assistant'; content: string }[] = []): ChatMessage[] {
  const timed = timedTranscript(src.timed);
  const block = [
    '<source id="S1">',
    `Title: ${neutralise(src.title, 300)}`,
    src.url ? `URL: ${neutralise(src.url, 300)}` : '',
    src.summary ? `Summary: ${neutralise(src.summary, 800)}` : '',
    src.note ? `User note: ${neutralise(src.note, 600)}` : '',
    timed ? `Transcript (each line starts with its [mm:ss] time):\n${neutralise(timed, BODY_BUDGET + 2000)}` : `Text:\n${neutralise(src.body, BODY_BUDGET)}`,
    '</source>',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: ITEM_RULES },
    ...history.slice(-6).map((h) => ({ role: h.role, content: neutralise(h.content, 2000) })),
    { role: 'user', content: `SOURCE:\n${block}\n\nTASK: Answer concisely in Markdown, citing moments.\n\nQUESTION: ${neutralise(question, 2000)}` },
  ];
}

/** Turn the `[mm:ss]` markers in an answer into validated moments; invented times are removed. */
export function citeMoments(answer: string, src: ItemQaSource): { answer: string; moments: ItemQaMoment[] } {
  const segs = segmentsOf(src);
  const starts = segs.map((s) => s.startMs);
  const moments: ItemQaMoment[] = [];
  const cleaned = answer.replace(MARKER_RE, (m) => {
    const ms = validStart(parseMarker(m) ?? -1, starts);
    if (ms === null) return '';
    if (!moments.some((x) => x.startMs === ms)) {
      const seg = segs.find((s) => s.startMs === ms);
      moments.push({ sid: `M${moments.length + 1}`, startMs: ms, quote: (seg?.text ?? '').slice(0, 220) });
    }
    return marker(ms);
  }).replace(/[ \t]{2,}/g, ' ');
  moments.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  return { answer: cleaned, moments };
}

/** Best passages for the question (no model): word overlap, keeping timestamps. */
export function retrievalItemAnswer(question: string, src: ItemQaSource, max = 4): ItemQaResult {
  const words = new Set(tokenize(question));
  const segs = segmentsOf(src);
  const pool: { startMs: number | null; text: string }[] = segs.length
    ? segs
    : src.body.split(/\n{2,}|(?<=[.!?])\s+/).map((t) => ({ startMs: null, text: t.trim() })).filter((p) => p.text.length > 20);
  const ranked = pool
    .map((p, i) => ({ ...p, i, score: new Set(tokenize(p.text).filter((w) => words.has(w))).size }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  // Keep strong matches only (at least half the best score), then show them in source order.
  const floor = Math.max(1, Math.ceil((ranked[0]?.score ?? 0) / 2));
  const scored = ranked.filter((p) => p.score >= floor).slice(0, max).sort((a, b) => a.i - b.i);
  if (!scored.length) {
    return {
      mode: src.summary ? 'retrieval_only' : 'no_evidence',
      answer: src.summary ? `No passage matches those words. Here is the summary:\n\n${src.summary}` : 'This item has no text that matches your question.',
      moments: [], provider: null, usage: null,
    };
  }
  const moments = scored.map((p, k) => ({ sid: p.startMs !== null ? `M${k + 1}` : `S${k + 1}`, startMs: p.startMs, quote: p.text.slice(0, 220) }));
  const answer = ['Matching passages (no AI model configured):', ...scored.map((p) => `- ${p.startMs !== null ? `${marker(p.startMs)} ` : ''}${p.text.slice(0, 300)}`)].join('\n');
  return { mode: 'retrieval_only', answer, moments, provider: null, usage: null };
}

export async function askItem(
  src: ItemQaSource, question: string, provider: ChatProvider | null, history: { role: 'user' | 'assistant'; content: string }[] = [],
  stream: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<ItemQaResult> {
  if (!provider) return retrievalItemAnswer(question, src);
  const messages = itemQaMessages(src, question, history);
  const res = provider.chatStream && stream.onDelta
    ? await provider.chatStream(messages, { maxTokens: 2500, signal: stream.signal }, stream.onDelta)
    : await provider.chat(messages, { maxTokens: 2500, signal: stream.signal });
  const { answer, moments } = citeMoments(res.content.trim() || 'The model returned no answer.', src);
  return { mode: 'model', answer, moments, provider: provider.label, usage: res.usage };
}
