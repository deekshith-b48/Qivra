/**
 * Dev mode feeds (pure, unit-tested): request URLs for GitHub search, Hacker News
 * (Algolia) and Hugging Face, parsers that turn their JSON into one FeedItem
 * shape, install commands for Claude Code repos, and the daily-habit streak.
 * All sources are public and keyless; the fetching lives in services/devFeeds.ts.
 */

export type FeedSource = 'github' | 'hn' | 'hf';

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
    if (!id || !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(id)) return []; // owner/name, no path tricks
    return [{ source: 'hf' as const, id: `hf:${id}`, title: id, url: `https://huggingface.co/${id}`, description: str(o.pipeline_tag).replace(/-/g, ' '), metric: num(o.likes), createdAt: str(o.createdAt) || null }];
  });
}

export type ClaudeKind = 'skills' | 'plugins' | 'mcp';

/** GitHub topics for each Claude Code section. */
export const CLAUDE_QUERIES: Record<ClaudeKind, string> = {
  skills: 'topic:claude-skills',
  plugins: 'topic:claude-code-plugin',
  mcp: 'topic:mcp-server',
};

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
  const prev = (k: string) => {
    const d = new Date(`${k}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  let k = doneDays.has(todayKey) ? todayKey : prev(todayKey);
  let n = 0;
  while (doneDays.has(k)) {
    n++;
    k = prev(k);
  }
  return n;
}
