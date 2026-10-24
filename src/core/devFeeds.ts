/**
 * Dev mode feeds (pure, unit-tested): request URLs for GitHub search, Hacker News
 * (Algolia) and Hugging Face, parsers that turn their JSON into one FeedItem
 * shape, install commands for Claude Code repos, and the daily-habit streak.
 * All sources are public and keyless; the fetching lives in services/devFeeds.ts.
 */

export type FeedSource = 'github' | 'hn' | 'hf';

import { stripMarkdown } from './metadata';

export interface FeedItem {
  source: FeedSource;
  id: string;
  title: string;
  url: string;
  description: string;
  /** Stars (GitHub), points (HN) or likes (Hugging Face). */
  metric: number;
  createdAt: string | null;
  /** GitHub owner/name, for install commands and saving. */
  repo?: string;
  /** A GitHub release of a followed repo (title holds the tag). */
  kind?: 'release';
  prerelease?: boolean;
}

/** owner/name with no path tricks (shared by Hugging Face ids and followed repos). */
const OWNER_NAME = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** A followed term that names a repo ("anthropics/claude-code"), so its releases are tracked. */
export function isRepoTerm(term: string): boolean {
  return OWNER_NAME.test(term.trim());
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** GitHub repository search. `q` uses GitHub's qualifiers (topic:, created:>, pushed:>, in:). */
export function githubSearchUrl(q: string, sort: 'stars' | 'updated' = 'stars', perPage = 15): string {
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${perPage}`;
}

/** New AI repositories of the last `days` days, most starred first. */
export function trendingAiReposUrl(nowMs: number, days = 7): string {
  return githubSearchUrl(`topic:llm created:>${day(nowMs - days * 86_400_000)}`);
}

/** Hacker News stories matching `query` since `sinceMs` with at least `minPoints`. */
export function hnSearchUrl(query: string, sinceMs: number, minPoints = 50, hits = 15): string {
  const filters = `created_at_i>${Math.floor(sinceMs / 1000)},points>${minPoints}`;
  return `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(query)}&numericFilters=${encodeURIComponent(filters)}&hitsPerPage=${hits}`;
}

export function githubReleasesUrl(repo: string, perPage = 5): string {
  const [owner, name] = repo.trim().split('/');
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=${perPage}`;
}

export function hfTrendingUrl(limit = 15): string {
  return `https://huggingface.co/api/models?sort=trendingScore&limit=${limit}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function parseGithub(json: unknown): FeedItem[] {
  const items = (json as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((r) => {
    const o = r as Record<string, unknown>;
    const name = str(o.full_name);
    const url = str(o.html_url);
    if (!name || !url.startsWith('https://github.com/')) return [];
    return [{ source: 'github' as const, id: `gh:${name}`, title: name, url, description: str(o.description).slice(0, 200), metric: num(o.stargazers_count), createdAt: str(o.created_at) || null, repo: name }];
  });
}

export function parseHn(json: unknown): FeedItem[] {
  const hits = (json as { hits?: unknown[] })?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.flatMap((h) => {
    const o = h as Record<string, unknown>;
    const id = str(o.objectID);
    const title = str(o.title);
    if (!id || !title) return [];
    // Ask/Show HN posts have no outside link: open the discussion instead.
    const link = str(o.url);
    const url = /^https?:\/\//.test(link) ? link : `https://news.ycombinator.com/item?id=${id}`;
    return [{ source: 'hn' as const, id: `hn:${id}`, title, url, description: `${num(o.num_comments)} comments on Hacker News`, metric: num(o.points), createdAt: str(o.created_at) || null }];
  });
}

export function parseHf(json: unknown): FeedItem[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((m) => {
    const o = m as Record<string, unknown>;
    const id = str(o.id) || str(o.modelId);
    if (!id || !OWNER_NAME.test(id)) return [];
    return [{ source: 'hf' as const, id: `hf:${id}`, title: id, url: `https://huggingface.co/${id}`, description: str(o.pipeline_tag).replace(/-/g, ' '), metric: num(o.likes), createdAt: str(o.createdAt) || null }];
  });
}

export function parseReleases(json: unknown, repo: string): FeedItem[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r) => {
    const o = r as Record<string, unknown>;
    const tag = str(o.tag_name);
    const url = str(o.html_url);
    if (o.draft === true || !tag || !url.startsWith('https://github.com/')) return [];
    const notes = stripMarkdown(str(o.body)).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return [{
      source: 'github' as const, id: `rel:${repo}@${tag}`, title: `${repo} ${tag}`, url, description: notes.slice(0, 200),
      metric: 0, createdAt: str(o.published_at) || null, repo, kind: 'release' as const, prerelease: o.prerelease === true,
    }];
  });
}

export type ClaudeKind = 'skills' | 'plugins' | 'mcp';

/** GitHub topics for each Claude Code section. */
export const CLAUDE_QUERIES: Record<ClaudeKind, string> = {
  skills: 'topic:claude-skills',
  plugins: 'topic:claude-code-plugin',
  mcp: 'topic:mcp-server',
};

export type ClaudeMode = 'top' | 'new';

/** Search for a Claude Code section: all-time most starred, or the best new ones of the last 7 days. */
export function claudeQuery(kind: ClaudeKind, mode: ClaudeMode, nowMs: number): string {
  return mode === 'new' ? `${CLAUDE_QUERIES[kind]} created:>${day(nowMs - 7 * 86_400_000)}` : CLAUDE_QUERIES[kind];
}

const RUNNERS = new Set(['npx', 'bunx', 'pipx', 'uvx', 'pnpx']);

/** The tool a command belongs to, for grouping: skips sudo/env/VAR=x, unwraps npx-style runners and python -m. */
export function commandGroup(cmd: string): string {
  const words = cmd.trim().replace(/^\$\s*/, '').split(/\s+/).filter(Boolean);
  while (words.length && (words[0] === 'sudo' || words[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words.shift();
  let w = words[0] ?? '';
  if (RUNNERS.has(w) && words[1]) w = words[1];
  else if (/^python\d?(\.\d+)?$/.test(w) && words[1] === '-m' && words[2]) w = words[2];
  return w.split('/').pop()!.toLowerCase() || 'other';
}

/** What to paste to install a repo: a Claude Code marketplace for plugins, a clone for the rest. */
export function installCommand(kind: ClaudeKind, repo: string): string {
  return kind === 'plugins' ? `/plugin marketplace add ${repo}` : `git clone https://github.com/${repo}.git`;
}

/** Interleave sources so the top of an "All" list mixes them; ids are de-duplicated. */
export function mixFeeds(...lists: FeedItem[][]): FeedItem[] {
  const out: FeedItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const l of lists) {
      const it = l[i];
      if (it && !seen.has(it.id)) {
        seen.add(it.id);
        out.push(it);
      }
    }
  }
  return out;
}

export interface Habits {
  saved: boolean;
  read: boolean;
  reviewed: boolean;
  trends: boolean;
}

/** A day counts towards the streak when at least three of the four habits are done. */
export function dayComplete(h: Habits): boolean {
  return [h.saved, h.read, h.reviewed, h.trends].filter(Boolean).length >= 3;
}

/**
 * Consecutive complete days ending today (or yesterday, so an unfinished today
 * doesn't break the streak). `doneDays` holds YYYY-MM-DD keys of complete days.
 */
export function streak(doneDays: Set<string>, todayKey: string): number {
  let k = doneDays.has(todayKey) ? todayKey : prevDay(todayKey);
  let n = 0;
  while (doneDays.has(k)) {
    n++;
    k = prevDay(k);
  }
  return n;
}

/** The YYYY-MM-DD key of the day before. */
export function prevDay(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The last `n` day keys ending with `todayKey`, oldest first. */
export function lastNDays(todayKey: string, n: number): string[] {
  const out = [todayKey];
  while (out.length < n) out.unshift(prevDay(out[0]));
  return out;
}

/** Longest run of consecutive complete days. */
export function bestStreak(doneDays: Set<string>): number {
  let best = 0;
  for (const d of doneDays) {
    if (doneDays.has(prevDay(d))) continue; // count each run once, from its first day
    let n = 1;
    let k = d;
    for (;;) {
      const next = new Date(`${k}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      k = next.toISOString().slice(0, 10);
      if (!doneDays.has(k)) break;
      n++;
    }
    best = Math.max(best, n);
  }
  return best;
}
