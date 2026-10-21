import { normalizeCitations, validateCitations } from '../../src/core/agent/citations';
import { parseInline, parseMarkdown } from '../../src/core/markdown';

test('tables become a table block (the screenshot case), including cells with citations', () => {
  const md = 'Comparison:\n\n| Source | Repository | Purpose |\n|--------|------------|---------|\n| S1 | agent-reach | Platform access [S1] |\n| S3 | free-tokens | 7B tokens/month [S3] |\n\nDone.';
  const b = parseMarkdown(md);
  expect(b.map((x) => x.type)).toEqual(['paragraph', 'table', 'paragraph']);
  const t = b[1] as Extract<typeof b[number], { type: 'table' }>;
  expect(t.header).toEqual(['Source', 'Repository', 'Purpose']);
  expect(t.rows[1]).toEqual(['S3', 'free-tokens', '7B tokens/month [S3]']);
});

test('a table still streaming in (no separator yet) is plain text, not garbage', () => {
  expect(parseMarkdown('| Source | Repo |').map((x) => x.type)).toEqual(['paragraph']);
});

test('code fences, numbered lists, headings, quotes and dividers', () => {
  const b = parseMarkdown('## Steps\n1. Install\n2. Run `npm test`\n   continued\n---\n> note\n```bash\nnpm i\n```');
  expect(b.map((x) => x.type)).toEqual(['heading', 'list', 'hr', 'quote', 'code']);
  const list = b[1] as Extract<typeof b[number], { type: 'list' }>;
  expect(list.ordered).toBe(true);
  expect(list.items.map((i) => i.marker)).toEqual(['1.', '2.']);
  expect(list.items[1].text).toBe('Run `npm test` continued');
  expect(b[4]).toMatchObject({ type: 'code', lang: 'bash', text: 'npm i', open: false });
  // An unclosed fence while streaming shows what has arrived as code.
  expect(parseMarkdown('```js\nconst a = 1;')).toEqual([{ type: 'code', lang: 'js', text: 'const a = 1;', open: true }]);
});

test('inline: bold, italic, strike, code, links, citations and timestamps', () => {
  const p = parseInline('**Bold** and *it* ~~old~~ `x` [site](https://a.b) see [S2] at [01:02] and [js](javascript:alert(1))');
  expect(p.filter((x) => x.t !== 'text').map((x) => x.t)).toEqual(['bold', 'italic', 'strike', 'code', 'link', 'cite', 'time']);
  expect(p.find((x) => x.t === 'time')).toMatchObject({ v: '01:02', ms: 62000 });
  // Non-http links are shown as text only.
  expect(p.at(-1)).toMatchObject({ t: 'text' });
  expect(p.some((x) => x.t === 'link' && x.href.startsWith('javascript'))).toBe(false);
});

test('citation shapes are normalised before validation', () => {
  expect(normalizeCitations('A【S1】 B [S1, S3] C (S2) D [S4; S5]')).toBe('A[S1] B [S1][S3] C [S2] D [S4][S5]');
  const v = validateCitations('Claim 【S1】 and 【S9】.', ['S1', 'S2']);
  expect(v.cited).toEqual(['S1']);
  expect(v.text).toBe('Claim [S1] and.');
});
