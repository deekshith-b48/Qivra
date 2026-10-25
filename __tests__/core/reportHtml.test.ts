import { escapeHtml, inlineHtml, markdownToHtmlBody, reportToHtml } from '../../src/core/reportHtml';
import { buildReport } from '../../src/core/reports';
import { rangeFor } from '../../src/core/dates';

describe('reportHtml', () => {
  test('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  test('a <script> in any position is rendered as text, never as a tag', () => {
    const md = [
      '# Title <script>alert(1)</script>',
      '<script>alert("body")</script>',
      '- item <img src=x onerror=alert(1)>',
      '> quote <iframe src="https://evil"></iframe>',
      '| a | b |',
      '| --- | --- |',
      '| <script>x</script> | `<b>` |',
      '```',
      '</code></pre><script>alert(2)</script>',
      '```',
    ].join('\n');
    const html = reportToHtml(md, 'T </title><script>alert(3)</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;');
    expect(html).toContain('<title>T &lt;/title&gt;&lt;script&gt;alert(3)&lt;/script&gt;</title>');
  });

  test('links: only http(s)/mailto become anchors; attributes cannot be broken out of', () => {
    expect(inlineHtml('[ok](https://example.com/a?b=1&c=2)')).toBe('<a href="https://example.com/a?b=1&amp;c=2">ok</a>');
    expect(inlineHtml('<https://example.com>')).toBe('<a href="https://example.com">https://example.com</a>');
    expect(inlineHtml('[bad](javascript:alert(1))')).not.toContain('<a');
    expect(inlineHtml('[x](https://a.com/"onmouseover=alert(1))')).not.toMatch(/href="[^"]*"[^>]*onmouseover/);
    expect(inlineHtml('[**bold** <b>](https://a.com)')).toBe('<a href="https://a.com"><strong>bold</strong> &lt;b&gt;</a>');
  });

  test('citations and timestamps become pills', () => {
    expect(inlineHtml('Hooks [S2] at [01:05]')).toBe('Hooks <span class="cite">S2</span> at <span class="ts">01:05</span>');
  });

  test('inline formatting', () => {
    expect(inlineHtml('**Saved:** `npm i` and _note_ here')).toBe('<strong>Saved:</strong> <code>npm i</code> and <em>note</em> here');
    expect(inlineHtml('snake_case_name stays')).toBe('snake_case_name stays');
  });

  test('headings, nested lists, ordered lists, tables, code and quotes', () => {
    const body = markdownToHtmlBody(['## Sources', '', '- a', '  - nested `x`', '- b', '', '1. one', '2. two', '', '| h1 | h2 |', '|---|:--:|', '| c1 | c2 |', '', '```bash', 'rm -rf / && echo "<hi>"', '```', '', '> _AI note_', '', 'plain text'].join('\n'));
    expect(body).toContain('<h2>Sources</h2>');
    expect(body).toContain('<ul><li>\na\n<ul><li>\nnested <code>x</code>\n</li></ul>\n</li><li>\nb\n</li></ul>');
    expect(body).toContain('<ol><li>\none\n</li><li>\ntwo\n</li></ol>');
    expect(body).toContain('<table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>c1</td><td>c2</td></tr></tbody></table>');
    expect(body).toContain('<pre><code>rm -rf / &amp;&amp; echo &quot;&lt;hi&gt;&quot;</code></pre>');
    expect(body).toContain('<blockquote><em>AI note</em></blockquote>');
    expect(body).toContain('<p>plain text</p>');
  });

  test('a full report becomes a self-contained document', () => {
    const r = buildReport({
      kind: 'weekly', range: rangeFor('week', Date.parse('2026-10-21T08:00:00Z'), 'UTC'), generatedAt: '2026-10-21T08:00:00Z',
      sources: [{ id: 'a', title: 'Evil <script>alert(1)</script>', url: 'https://example.com', sourceType: 'web', capturedAt: '2026-10-20T00:00:00Z', summary: 'x', summaryOrigin: 'extracted', note: '', tags: ['ai'], language: 'en', enrichment: null, transcriptLanguages: [], hasTranscript: false, highlights: [] }],
    });
    const html = reportToHtml(r.markdown, r.title);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script|<link|src=/i);
    expect(html).toContain('<h1>Qivra Weekly Learning Report');
    expect(html).toContain('<div class="stat"><b>1</b><span>item</span></div>');
    expect(html).toContain('<section><h2>By source</h2>');
    expect(html).toContain('<div class="src"><p><span class="cite">S1</span> <strong>Web</strong> · <a href="https://example.com">Evil &lt;script&gt;alert(1)&lt;/script&gt;</a></p>');
    expect(html).toContain('<footer>');
  });
});
