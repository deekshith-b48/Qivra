/**
 * Translating transcripts to English with the user's AI model (pure, unit-tested).
 * Lines are sent in numbered batches and must come back as exactly as many lines,
 * so every translated line keeps its original timestamp.
 */

import type { ChatMessage } from './ai/provider';

export const TRANSLATION_BATCH = 40;

export function translationMessages(lines: string[], fromLanguage: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'You translate transcript lines into natural, faithful English. Keep names, numbers and technical terms. Do not add, merge, drop or explain lines. Reply with only a JSON array of strings.',
    },
    {
      role: 'user',
      content: `Translate these ${lines.length} lines${fromLanguage ? ` from ${fromLanguage}` : ''} into English. Reply with a JSON array of exactly ${lines.length} strings, in the same order.\n${JSON.stringify(lines)}`,
    },
  ];
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
