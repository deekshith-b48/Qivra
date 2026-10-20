/** Model-based enrichment: prompt + defensive parsing, merged with local evidence. */

import type { Enrichment } from './enrich';
import { neutralise, SYSTEM_RULES } from './agent/guard';

export function enrichmentPrompt(title: string, url: string | null, note: string, body: string): string {
  return `${SYSTEM_RULES}

Extract structured knowledge from the single SOURCE below. Respond with ONLY a JSON object with these keys:
"summary" (2-4 sentences), "keyPoints" (string[]), "concepts" (string[]), "tags" (string[] of short lowercase tags),
"followUpQuestions" (string[]), "actionItems" (string[]). Use only information present in the source.

<source id="S1">
Title: ${neutralise(title, 300)}
URL: ${neutralise(url ?? '', 300)}
User note: ${neutralise(note, 2000)}
Text: ${neutralise(body, 14000)}
</source>

JSON:`;
}

export function parseModelEnrichment(raw: string): Partial<Enrichment> | null {
  const m = /\{[\s\S]*\}/.exec(raw ?? '');
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const list = (k: string, max = 20) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 300)).slice(0, max) : []);
  const summary = typeof o.summary === 'string' ? o.summary.slice(0, 2000) : '';
  if (!summary && !list('keyPoints').length) return null;
  return {
    summary,
    keyPoints: list('keyPoints', 10),
    concepts: list('concepts', 15),
    tags: list('tags', 8).map((t) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 40)),
    followUpQuestions: list('followUpQuestions', 8),
    actionItems: list('actionItems', 8),
  };
}

/**
 * Model output never replaces evidence: commands, repositories, URLs and
 * timestamps stay as extracted verbatim from the source.
 */
export function mergeModelEnrichment(local: Enrichment, model: Partial<Enrichment>, provider: string, now: string): Enrichment {
  return {
    ...local,
    origin: 'model',
    provider,
    generatedAt: now,
    summary: model.summary || local.summary,
    keyPoints: model.keyPoints?.length ? model.keyPoints : local.keyPoints,
    concepts: model.concepts?.length ? model.concepts : local.concepts,
    tags: model.tags?.length ? model.tags : local.tags,
    followUpQuestions: model.followUpQuestions ?? [],
    actionItems: model.actionItems?.length ? model.actionItems : local.actionItems,
  };
}
