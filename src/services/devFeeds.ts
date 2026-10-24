/**
 * Dev mode data: public trend feeds (GitHub, Hacker News, Hugging Face), the
 * Claude Code corner, follow-ups on topics you follow, and daily habits.
 * Feeds are cached in the local database so the tab opens instantly and stays
 * well inside GitHub's unauthenticated limit (10 searches a minute). Only public
 * queries leave the phone; nothing from the library is sent.
 */

import { localDate, rangeFor } from '../core/dates';
import {
  bestStreak, CLAUDE_QUERIES, type ClaudeKind, type ClaudeMode, claudeQuery, dayComplete, type FeedItem, githubReleasesUrl, githubSearchUrl,
  type Habits, hfTrendingUrl, hnSearchUrl, isRepoTerm, lastNDays, mixFeeds, parseGithub, parseHf, parseHn, parseReleases, streak,
  trendingAiReposUrl,
} from '../core/devFeeds';
import { getRepo } from './db';
import { fetchText } from './http';
import { getSettings } from './settings';

const HOUR = 3_600_000;

interface Cached<T> {
  at: number;
  data: T;
}

export interface FeedResult<T> {
  data: T;
  /** When the data was fetched (ms). */
  at: number | null;
  /** Set when a refresh failed and older (or no) data is shown. */
  error: string | null;
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetchText(url, { accept: 'application/json', timeoutMs: 12_000 });
  if (r.status === 403 || r.status === 429) throw new Error('The service is busy (rate limit). Try again in a minute.');
  if (!r.ok) throw new Error(`The service answered ${r.status}.`);
  return JSON.parse(r.text);
}

/** Cached fetch: fresh data within `maxAgeMs`, otherwise refetch; on failure keep the last copy. */
async function cached<T>(key: string, maxAgeMs: number, force: boolean, load: () => Promise<T>, empty: T): Promise<FeedResult<T>> {
  const repo = await getRepo();
  const prev = await repo.getJson<Cached<T> | null>(`dev.cache.${key}`, null);
  if (prev && !force && Date.now() - prev.at < maxAgeMs) return { data: prev.data, at: prev.at, error: null };
  try {
    const data = await load();
    const at = Date.now();
    await repo.setJson(`dev.cache.${key}`, { at, data });
    return { data, at, error: null };
  } catch (e) {
    return { data: prev?.data ?? empty, at: prev?.at ?? null, error: (e as Error).message || 'Could not refresh.' };
  }
}

export interface Trends {
  github: FeedItem[];
  hn: FeedItem[];
  hf: FeedItem[];
}

export async function getTrends(force = false): Promise<FeedResult<Trends>> {
  return cached<Trends>('trends', 6 * HOUR, force, async () => {
    const now = Date.now();
    // Each source on its own, so one failing doesn't hide the others.
    const [github, hn, hf] = await Promise.all([
      getJson(trendingAiReposUrl(now)).then(parseGithub).catch(() => []),
      getJson(hnSearchUrl('AI', now - 48 * HOUR)).then(parseHn).catch(() => []),
      getJson(hfTrendingUrl()).then(parseHf).catch(() => []),
    ]);
    if (!github.length && !hn.length && !hf.length) throw new Error('No trends could be loaded. Check your connection.');
    return { github, hn, hf };
  }, { github: [], hn: [], hf: [] });
}

export function allTrends(t: Trends): FeedItem[] {
  return mixFeeds(t.github, t.hn, t.hf);
}

export async function getClaudeCorner(force = false, mode: ClaudeMode = 'top'): Promise<FeedResult<Record<ClaudeKind, FeedItem[]>>> {
  return cached(`claude.${mode}`, 6 * HOUR, force, async () => {
    const out = {} as Record<ClaudeKind, FeedItem[]>;
    const now = Date.now();
    for (const kind of Object.keys(CLAUDE_QUERIES) as ClaudeKind[]) {
      out[kind] = parseGithub(await getJson(githubSearchUrl(claudeQuery(kind, mode, now), 'stars', 10)));
    }
    return out;
  }, { skills: [], plugins: [], mcp: [] });
}

export interface FollowUp {
  term: string;
  /** New repos/stories since the last time you opened this topic. */
  items: FeedItem[];
  since: number;
}

const followKey = (term: string) => `dev.follow.seen.${term.toLowerCase()}`;

/** What is new for each followed topic since you last marked it seen (first time: the last 7 days). */
export async function getFollowUps(force = false): Promise<FeedResult<FollowUp[]>> {
  const { devFollows } = await getSettings();
  const repo = await getRepo();
  const sinceOf = async (t: string) => Number((await repo.getMeta(followKey(t))) ?? 0) || Date.now() - 7 * 24 * HOUR;
  const sig = devFollows.map((t) => t.toLowerCase()).sort().join('|');
  return cached(`follow.${sig}`, 2 * HOUR, force, async () => {
    const out: FollowUp[] = [];
    for (const term of devFollows) {
      const since = await sinceOf(term);
      const sinceDay = new Date(since).toISOString().slice(0, 10);
      const [releases, gh, hn] = await Promise.all([
        // A followed owner/repo also tracks that repo's releases.
        isRepoTerm(term)
          ? getJson(githubReleasesUrl(term)).then((j) => parseReleases(j, term.trim()).filter((r) => r.createdAt && Date.parse(r.createdAt) > since)).catch(() => [])
          : Promise.resolve([] as FeedItem[]),
        getJson(githubSearchUrl(`${term} in:name,description,topics pushed:>${sinceDay}`, 'stars', 5)).then(parseGithub).catch(() => []),
        getJson(hnSearchUrl(term, since, 10, 5)).then(parseHn).catch(() => []),
      ]);
      out.push({ term, items: [...releases, ...mixFeeds(gh, hn)], since });
    }
    return out;
  }, []);
}

/** Opening a topic's results marks them seen; the next check counts from now. */
export async function markFollowSeen(term: string): Promise<void> {
  const repo = await getRepo();
  await repo.setMeta(followKey(term), String(Date.now()));
  // The cached result for the current follow list is now stale.
  const { devFollows } = await getSettings();
  await repo.setMeta(`dev.cache.follow.${devFollows.map((t) => t.toLowerCase()).sort().join('|')}`, 'null');
}

// ── daily habits ────────────────────────────────────────────────────────────

async function todayKey(): Promise<{ key: string; timezone: string }> {
  const { timezone } = await getSettings();
  return { key: localDate(Date.now(), timezone), timezone };
}

/** Called when a flashcard is graded. */
export async function noteCardReviewed(): Promise<void> {
  const repo = await getRepo();
  const { key } = await todayKey();
  await repo.setMeta(`dev.reviewed.${key}`, '1');
}

/** Called when the Dev tab is opened. */
export async function noteTrendsChecked(): Promise<void> {
  const repo = await getRepo();
  const { key } = await todayKey();
  await repo.setMeta(`dev.trends.${key}`, '1');
}

export interface WeekRecap {
  saved: number;
  read: number;
  reviewDays: number;
  activeDays: number;
}

export async function getHabits(): Promise<{
  habits: Habits;
  streak: number;
  best: number;
  /** The last 35 days, oldest first. */
  heatmap: { day: string; done: boolean }[];
  week: WeekRecap;
}> {
  const repo = await getRepo();
  const { key, timezone } = await todayKey();
  const r = rangeFor('today', Date.now(), timezone);
  const habits: Habits = {
    saved: (await repo.countWhere('captured_at >= ? AND captured_at < ?', [r.startIso, r.endIso])) > 0,
    read: (await repo.countWhere('last_viewed_at >= ? AND last_viewed_at < ?', [r.startIso, r.endIso])) > 0,
    reviewed: (await repo.getMeta(`dev.reviewed.${key}`)) === '1',
    trends: (await repo.getMeta(`dev.trends.${key}`)) === '1',
  };
  if (dayComplete(habits)) await repo.setMeta(`dev.day.${key}`, '1');
  const days = new Set((await repo.metaKeys('dev.day.')).map((k) => k.slice('dev.day.'.length)));
  const heatmap = lastNDays(key, 35).map((day) => ({ day, done: days.has(day) }));
  const w = rangeFor('week', Date.now(), timezone);
  const weekDays = new Set(lastNDays(key, 7));
  const week: WeekRecap = {
    saved: await repo.countWhere('captured_at >= ? AND captured_at < ?', [w.startIso, w.endIso]),
    read: await repo.countWhere('last_viewed_at >= ? AND last_viewed_at < ?', [w.startIso, w.endIso]),
    reviewDays: (await repo.metaKeys('dev.reviewed.')).filter((k) => weekDays.has(k.slice('dev.reviewed.'.length))).length,
    activeDays: heatmap.slice(-7).filter((d) => d.done).length,
  };
  return { habits, streak: streak(days, key), best: bestStreak(days), heatmap, week };
}

/**
 * Background (morning) check: one notification a day when followed topics have
 * something new. Runs only with Dev mode and its notification turned on.
 */
export async function notifyFollowUps(now = new Date()): Promise<boolean> {
  const s = await getSettings();
  if (!s.devMode || !s.devFollowNotify || !s.devFollows.length) return false;
  const repo = await getRepo();
  const key = localDate(now.getTime(), s.timezone);
  if (now.getHours() < 7 || (await repo.getMeta(`dev.notified.${key}`)) === '1') return false;
  const Notifications = await import('expo-notifications');
  if (!(await Notifications.getPermissionsAsync()).granted) return false;
  const res = await getFollowUps();
  // Releases by name first ("anthropics/claude-code v2.1.0 released"), then counts per topic.
  const releases = res.data.flatMap((f) => f.items.filter((i) => i.kind === 'release').slice(0, 1).map((i) => `${i.title} released`));
  const parts = [...releases, ...res.data.filter((f) => f.items.some((i) => i.kind !== 'release')).map((f) => `${f.items.filter((i) => i.kind !== 'release').length} new for ${f.term}`)];
  if (!parts.length) return false;
  await Notifications.scheduleNotificationAsync({
    content: { title: 'New in topics you follow', body: parts.join(', '), data: { url: 'qivra://dev' } },
    trigger: null,
  });
  await repo.setMeta(`dev.notified.${key}`, '1');
  return true;
}
