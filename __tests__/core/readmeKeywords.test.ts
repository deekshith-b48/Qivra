import { extractTools } from '../../src/core/enrich';
import { extractKeywords } from '../../src/core/highlights';
import { cleanMarkdown, markdownProse, stripMarkdown } from '../../src/core/metadata';

const README = `<p align="center"><img src="logo.png" width="120"></p>

[![Stars](https://img.shields.io/github/stars/a/b)](https://github.com/a/b) [![MIT](https://img.shields.io/badge/MIT-blue)](https://opensource.org/licenses/MIT)

# The Agency
A complete **AI agency** at your fingertips. See [the docs](https://agency.dev/docs).

  ### 🆕 There's an app now
<!-- hidden note -->
\`\`\`bash
npm install <package>
\`\`\`
Use \`Array<string>\` for lists.`;

test('a README becomes clean Markdown: no badges, images, HTML or comments; headings and code kept', () => {
  const md = cleanMarkdown(README);
  expect(md).not.toMatch(/shields\.io|<img|<p align|\[\]\(|hidden note/);
  expect(md).toContain('# The Agency');
  expect(md).toContain('### 🆕 There\'s an app now'); // indented heading fixed
  expect(md).toContain('[the docs](https://agency.dev/docs)');
  expect(md).toContain('npm install <package>'); // code is untouched
  expect(md).toContain('`Array<string>`');
  expect(stripMarkdown(README)).not.toMatch(/\[\]\(|###|\*\*/);
});

test('links are not mentions: a GitHub URL does not make GitHub a tool or keyword', () => {
  expect(extractTools('Source: https://github.com/a/b and github.com/c/d')).toEqual([]);
  expect(extractTools('Push it to GitHub.')).toEqual(['GitHub']);
  const kw = extractKeywords([{ startMs: null, endMs: null, text: 'See https://github.com/x/y and https://github.com/x/z. Indexes speed up queries. Indexes matter.' }], { tools: ['GitHub'] });
  expect(kw.map((k) => k.term)).not.toContain('GitHub');
});

test('tools take at most half the keyword slots, so the topic still shows', () => {
  const text = 'Agents for Gemini, Cursor, Copilot, Windsurf, MCP and Rust. Specialist agents review code. Specialist agents write tests. Specialist agents ship.';
  const kw = extractKeywords([{ startMs: null, endMs: null, text }], { tools: extractTools(text), max: 6 });
  expect(kw.filter((k) => k.isTool).length).toBeLessThanOrEqual(3);
  expect(kw.map((k) => k.term)).toContain('specialist agents');
});

test('README keywords come from prose, not code, file names or flags', () => {
  const md = 'Run `--device insane` or:\n```bash\ntranscribe-anything video.mp4 --device insane\ntranscribe-anything video.mp4 --device insane\n```\nSpeaker diarization labels each speaker. Speaker diarization needs a GPU.';
  const kw = extractKeywords([{ startMs: null, endMs: null, text: markdownProse(md) }], { concepts: ['video.mp4', 'speaker diarization'] });
  const terms = kw.map((k) => k.term);
  expect(terms).toContain('speaker diarization');
  expect(terms).not.toContain('video.mp4');
  expect(terms).not.toContain('insane');
});
