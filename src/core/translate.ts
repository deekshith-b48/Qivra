/**
 * Translating transcripts with the user's AI model (pure, unit-tested): any language into English, and
 * English into the four Indian languages Qivra offers (Kannada, Hindi, Telugu, Tamil).
 * Lines are sent in numbered batches and must come back as exactly as many lines,
 * so every translated line keeps its original timestamp.
 */

import type { ChatMessage } from './ai/provider';

export const TRANSLATION_BATCH = 40;

/** The languages a transcript and summary can be translated into, besides English (the app's language). */
export const INDIAN_LANGUAGES = [
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
] as const;
export type IndianLanguage = (typeof INDIAN_LANGUAGES)[number]['code'];
export const isIndianLanguage = (code: string): code is IndianLanguage => INDIAN_LANGUAGES.some((l) => l.code === code);
const nameOf = (code: string) => INDIAN_LANGUAGES.find((l) => l.code === code)?.name ?? 'English';

/** Messages to translate transcript lines from `fromLanguage` (a name, or '' when unknown) into `to` (a code; default English). */
export function translationMessages(lines: string[], fromLanguage: string, to = 'en'): ChatMessage[] {
  const target = nameOf(to);
  const script = to === 'en' ? '' : ` Write in ${target} script; keep English technical terms, names and commands as they are.`;
  return [
    {
      role: 'system',
      content: `You translate transcript lines into natural, faithful ${target}. Keep names, numbers and technical terms. Do not add, merge, drop or explain lines.${script} Reply with only a JSON array of strings.`,
    },
    {
      role: 'user',
      content: `Translate these ${lines.length} lines${fromLanguage ? ` from ${fromLanguage}` : ''} into ${target}. Reply with a JSON array of exactly ${lines.length} strings, in the same order.\n${JSON.stringify(lines)}`,
    },
  ];
}

/** An item's summary in another language: TL;DR, summary and key moments (with their original times). */
export interface SummaryTranslation {
  tldr: string;
  summary: string;
  moments: { text: string; startMs: number | null }[];
}

export function summaryTranslationMessages(src: SummaryTranslation, to: IndianLanguage): ChatMessage[] {
  const payload = { tldr: src.tldr, summary: src.summary, moments: src.moments.map((m) => m.text) };
  return [
    {
      role: 'system',
      content: `You translate an English summary into natural ${nameOf(to)} (${nameOf(to)} script). Keep names, numbers, commands and technical terms in English. Reply with only JSON of the same shape: {"tldr": string, "summary": string, "moments": string[]} with exactly as many moments as given.`,
    },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

/** The translated summary (moment times copied from `src`), or null when the reply has the wrong shape. */
export function parseSummaryTranslation(reply: string, src: SummaryTranslation): SummaryTranslation | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(reply.slice(start, end + 1)) as { tldr?: unknown; summary?: unknown; moments?: unknown };
    if (typeof j.tldr !== 'string' || typeof j.summary !== 'string' || !Array.isArray(j.moments) || j.moments.length !== src.moments.length) return null;
    if (!j.moments.every((m) => typeof m === 'string')) return null;
    return { tldr: j.tldr.trim(), summary: j.summary.trim(), moments: (j.moments as string[]).map((text, i) => ({ text: text.trim(), startMs: src.moments[i].startMs })) };
  } catch {
    return null;
  }
}

/** The translated lines, or null when the reply is not a JSON array of exactly `n` strings. */
export function parseTranslationBatch(reply: string, n: number): string[] | null {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length !== n || !arr.every((x) => typeof x === 'string')) return null;
  return (arr as string[]).map((x) => x.trim());
}
