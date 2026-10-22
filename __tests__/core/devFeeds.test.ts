import {
  dayComplete, githubSearchUrl, hfTrendingUrl, hnSearchUrl, installCommand, mixFeeds, parseGithub, parseHf, parseHn, streak, trendingAiReposUrl,
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
