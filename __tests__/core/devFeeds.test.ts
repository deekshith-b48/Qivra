import {
  bestStreak, claudeQuery, commandGroup, dayComplete, githubReleasesUrl, githubSearchUrl, hfTrendingUrl, hnSearchUrl, installCommand, isRepoTerm,
  lastNDays, mixFeeds, parseGithub, parseHf, parseHn, parseReleases, streak, trendingAiReposUrl,
} from '../../src/core/devFeeds';

test('request URLs are encoded (HN filters need %3E for ">")', () => {
  expect(trendingAiReposUrl(Date.UTC(2026, 9, 23))).toBe('https://api.github.com/search/repositories?q=topic%3Allm%20created%3A%3E2026-10-16&sort=stars&order=desc&per_page=15');
  expect(hnSearchUrl('Claude Code', 1_800_000_000_000, 50, 5)).toBe(
    'https://hn.algolia.com/api/v1/search?tags=story&query=Claude%20Code&numericFilters=created_at_i%3E1800000000%2Cpoints%3E50&hitsPerPage=5');
  expect(githubSearchUrl('MCP in:name', 'updated', 5)).toContain('q=MCP%20in%3Aname&sort=updated');
  expect(hfTrendingUrl(3)).toBe('https://huggingface.co/api/models?sort=trendingScore&limit=3');
});

test('GitHub, Hacker News and Hugging Face JSON become one feed shape; bad entries are dropped', () => {
  expect(parseGithub({ items: [
    { full_name: 'thedotmack/claude-mem', html_url: 'https://github.com/thedotmack/claude-mem', description: 'Memory for Claude Code', stargazers_count: 12000, created_at: '2026-01-01T00:00:00Z' },
    { full_name: 'x/y', html_url: 'javascript:alert(1)' },
  ] })).toEqual([{ source: 'github', id: 'gh:thedotmack/claude-mem', title: 'thedotmack/claude-mem', url: 'https://github.com/thedotmack/claude-mem', description: 'Memory for Claude Code', metric: 12000, createdAt: '2026-01-01T00:00:00Z', repo: 'thedotmack/claude-mem' }]);
  const hn = parseHn({ hits: [
    { objectID: '1', title: 'Show HN: a thing', points: 120, num_comments: 40, created_at: '2026-10-22T10:00:00Z' },
    { objectID: '2', title: 'AI finds bugs', url: 'https://example.com/a', points: 300 },
  ] });
  expect(hn.map((h) => h.url)).toEqual(['https://news.ycombinator.com/item?id=1', 'https://example.com/a']);
  expect(hn[0]).toMatchObject({ metric: 120, description: '40 comments on Hacker News' });
  expect(parseHf([{ id: 'deepseek-ai/DeepSeek-V4', likes: 2300, pipeline_tag: 'text-generation' }, { id: '../etc' }]))
    .toEqual([{ source: 'hf', id: 'hf:deepseek-ai/DeepSeek-V4', title: 'deepseek-ai/DeepSeek-V4', url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4', description: 'text generation', metric: 2300, createdAt: null }]);
  expect(parseGithub({ message: 'API rate limit exceeded' })).toEqual([]);
});

test('install commands and mixed feeds', () => {
  expect(installCommand('plugins', 'DietrichGebert/ponytail')).toBe('/plugin marketplace add DietrichGebert/ponytail');
  expect(installCommand('mcp', 'n8n-io/n8n')).toBe('git clone https://github.com/n8n-io/n8n.git');
  const a = { source: 'github' as const, id: 'a', title: 'a', url: '', description: '', metric: 0, createdAt: null };
  const b = { ...a, source: 'hn' as const, id: 'b' };
  const c = { ...a, id: 'c' };
  expect(mixFeeds([a, c], [b, a]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
});

test('habits: three of four complete a day; the streak survives an unfinished today', () => {
  expect(dayComplete({ saved: true, read: true, reviewed: false, trends: true })).toBe(true);
  expect(dayComplete({ saved: true, read: false, reviewed: false, trends: true })).toBe(false);
  const done = new Set(['2026-10-20', '2026-10-21', '2026-10-22']);
  expect(streak(done, '2026-10-23')).toBe(3); // today not done yet
  expect(streak(new Set([...done, '2026-10-23']), '2026-10-23')).toBe(4);
  expect(streak(new Set(['2026-10-20']), '2026-10-23')).toBe(0);
});

test('followed owner/repo terms track releases; drafts and non-GitHub links are dropped', () => {
  expect(isRepoTerm('anthropics/claude-code')).toBe(true);
  expect(isRepoTerm(' anthropics/claude-code ')).toBe(true);
  for (const bad of ['MCP', '../etc', 'a/b/c', 'a b/c', '/x', 'x/']) expect(isRepoTerm(bad)).toBe(false);
  expect(githubReleasesUrl('anthropics/claude-code')).toBe('https://api.github.com/repos/anthropics/claude-code/releases?per_page=5');
  const rel = parseReleases([
    { tag_name: 'v2.1.0', html_url: 'https://github.com/a/b/releases/tag/v2.1.0', published_at: '2026-10-22T10:00:00Z', body: '## Highlights\n- **Faster** startup' },
    { tag_name: 'v2.2.0-beta', html_url: 'https://github.com/a/b/releases/tag/v2.2.0-beta', prerelease: true, body: '' },
    { tag_name: 'v3', html_url: 'https://github.com/a/b/releases/tag/v3', draft: true },
    { tag_name: 'evil', html_url: 'javascript:alert(1)' },
  ], 'a/b');
  expect(rel.map((r) => [r.title, r.kind, r.prerelease])).toEqual([['a/b v2.1.0', 'release', false], ['a/b v2.2.0-beta', 'release', true]]);
  expect(rel[0]).toMatchObject({ description: 'Highlights', createdAt: '2026-10-22T10:00:00Z', id: 'rel:a/b@v2.1.0' });
  expect(parseReleases({ message: 'Not Found' }, 'a/b')).toEqual([]);
});

test('Claude corner "new this week" adds a created-since filter', () => {
  expect(claudeQuery('plugins', 'top', Date.UTC(2026, 9, 23))).toBe('topic:claude-code-plugin');
  expect(claudeQuery('mcp', 'new', Date.UTC(2026, 9, 23))).toBe('topic:mcp-server created:>2026-10-16');
});

test('commands group by the tool they run', () => {
  expect(commandGroup('git status')).toBe('git');
  expect(commandGroup('sudo apt install ffmpeg')).toBe('apt');
  expect(commandGroup('npx expo prebuild --clean')).toBe('expo');
  expect(commandGroup('python3 -m pytest -q')).toBe('pytest');
  expect(commandGroup('FOO=1 BAR=2 npm run build')).toBe('npm');
  expect(commandGroup('$ Docker ps')).toBe('docker');
  expect(commandGroup('./gradlew assembleRelease')).toBe('gradlew');
  expect(commandGroup('')).toBe('other');
});

test('heatmap days and best streak', () => {
  const days = lastNDays('2026-11-02', 35);
  expect(days).toHaveLength(35);
  expect(days[0]).toBe('2026-09-29');
  expect(days.slice(-3)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']); // across the month boundary
  expect(bestStreak(new Set(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']))).toBe(3);
  expect(bestStreak(new Set())).toBe(0);
});
