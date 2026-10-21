/**
 * Smart collections: a collection defined by rules instead of hand-picked
 * items. Rules are stored as JSON on the collection (`rules_json`) and turned
 * into an ordinary LibraryFilter, so every list, count and report that takes a
 * collection id works the same for manual and smart collections.
 */

import type { LibraryFilter } from './search';
import type { ItemStatus } from './status';
import type { SourceType } from './url';

export interface SmartRules {
  sourceTypes?: SourceType[];
  tags?: string[];
  /** Matched case-insensitively against the item's `enrichment.concepts`. */
  concepts?: string[];
  /** Full-text query (same as the library search box). */
  text?: string;
  statuses?: ItemStatus[];
  /** Captured within the last N days. */
  savedWithinDays?: number;
  /** Only items never opened (`last_viewed_at IS NULL`). */
  unread?: boolean;
}

const MAX_LIST = 20;
const MAX_TEXT = 200;

const strList = (v: unknown, lower = false): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => (lower ? s.toLowerCase() : s).trim().slice(0, 80))
    .filter(Boolean);
  return out.length ? [...new Set(out)].slice(0, MAX_LIST) : undefined;
};

/** Parse stored or synced rules defensively; anything unknown is dropped. Returns null when no rule remains. */
export function sanitizeRules(raw: unknown): SmartRules | null {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const r: SmartRules = {};
  const sourceTypes = strList(o.sourceTypes);
  if (sourceTypes) r.sourceTypes = sourceTypes as SourceType[];
  const statuses = strList(o.statuses);
  if (statuses) r.statuses = statuses as ItemStatus[];
  const tags = strList(o.tags, true);
  if (tags) r.tags = tags;
  const concepts = strList(o.concepts, true);
  if (concepts) r.concepts = concepts;
  if (typeof o.text === 'string' && o.text.trim()) r.text = o.text.trim().slice(0, MAX_TEXT);
  const days = Number(o.savedWithinDays);
  if (o.savedWithinDays !== undefined && o.savedWithinDays !== null && Number.isFinite(days) && days > 0) r.savedWithinDays = Math.min(3650, Math.round(days));
  if (o.unread === true) r.unread = true;
  return Object.keys(r).length ? r : null;
}

/** Pure conversion of rules to a library filter, relative to `now`. */
export function rulesToFilter(rules: SmartRules, now: Date = new Date()): LibraryFilter {
  const f: LibraryFilter = {};
  if (rules.sourceTypes?.length) f.sourceTypes = [...rules.sourceTypes];
  if (rules.statuses?.length) f.statuses = [...rules.statuses];
  if (rules.tags?.length) f.tags = rules.tags.map((t) => t.toLowerCase());
  if (rules.concepts?.length) f.concepts = rules.concepts.map((t) => t.toLowerCase());
  if (rules.text?.trim()) f.text = rules.text.trim();
  if (rules.savedWithinDays && rules.savedWithinDays > 0) f.fromIso = new Date(now.getTime() - rules.savedWithinDays * 86400_000).toISOString();
  if (rules.unread) f.unread = true;
  return f;
}

/** Short human description, e.g. "YouTube · #rag · unread · last 7 days". */
export function describeRules(rules: SmartRules): string {
  const parts: string[] = [];
  if (rules.sourceTypes?.length) parts.push(rules.sourceTypes.join(', '));
  if (rules.statuses?.length) parts.push(rules.statuses.map((s) => s.toLowerCase().replace(/_/g, ' ')).join(', '));
  for (const t of rules.tags ?? []) parts.push(`#${t}`);
  for (const c of rules.concepts ?? []) parts.push(c);
  if (rules.text) parts.push(`“${rules.text}”`);
  if (rules.unread) parts.push('unread');
  if (rules.savedWithinDays) parts.push(`last ${rules.savedWithinDays} days`);
  return parts.join(' · ') || 'Everything';
}
