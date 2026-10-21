/**
 * Report Markdown → self-contained HTML for PDF printing (expo-print).
 * Pure and dependency-free. Every piece of text is HTML-escaped; only the
 * tags produced here reach the output, and links are limited to http(s)/mailto.
 * Supports what reports use: headings, nested lists, quotes, tables, fenced
 * code, bold, italics, inline code and links.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s"'<>]+$/i;

function emphasis(text: string): string {
  // `text` is already escaped; markers are plain ASCII so they survive escaping.
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
}

function link(label: string, url: string): string {
  if (!SAFE_URL.test(url)) return escapeHtml(label === url ? url : `${label} (${url})`);
  return `<a href="${escapeHtml(url)}">${emphasis(escapeHtml(label))}</a>`;
}

/** Inline Markdown → HTML. */
export function inlineHtml(text: string): string {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^)\s]+\)|<(?:https?:|mailto:)[^>\s]+>)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 0) return emphasis(escapeHtml(p));
      if (p.startsWith('`')) return `<code>${escapeHtml(p.slice(1, -1))}</code>`;
      if (p.startsWith('<')) return link(p.slice(1, -1), p.slice(1, -1));
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
      return m ? link(m[1], m[2]) : escapeHtml(p);
    })
    .join('');
}

const CSS = `
@page { margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, Roboto, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; background: #fff; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 10pt; padding-bottom: 6pt; border-bottom: 2px solid #222; }
h2 { font-size: 14pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #ccc; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 12pt 0 4pt; page-break-after: avoid; }
h4, h5, h6 { font-size: 11pt; margin: 10pt 0 4pt; }
p { margin: 4pt 0; }
ul, ol { margin: 4pt 0; padding-left: 18pt; }
li { margin: 2pt 0; }
blockquote { margin: 6pt 0; padding: 4pt 10pt; border-left: 3px solid #888; color: #555; background: #f6f6f6; }
code { font-family: Menlo, Consolas, "Roboto Mono", monospace; font-size: 9.5pt; background: #f0f0f0; padding: 0 3px; border-radius: 3px; }
pre { background: #f4f4f4; border: 1px solid #ddd; border-radius: 4px; padding: 8pt; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 10pt; page-break-inside: avoid; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f0f0f0; }
a { color: #1a4fb4; text-decoration: none; word-break: break-all; }
hr { border: 0; border-top: 1px solid #ccc; margin: 12pt 0; }
`;

const tableCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Markdown body → HTML fragment (no <html> wrapper). */
export function markdownToHtmlBody(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const listStack: { indent: number; tag: 'ul' | 'ol' }[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineHtml).join('<br>')}</p>`);
    para = [];
  };
  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) out.push(`</li></${listStack.pop()?.tag}>`);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      closeLists();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      closeLists();
      out.push(`<h${h[1].length}>${inlineHtml(h[2])}</h${h[1].length}>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      closeLists();
      out.push('<hr>');
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      closeLists();
      const head = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
      i--;
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_h, k) => `<td>${inlineHtml(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara();
      closeLists();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${quote.map(inlineHtml).join('<br>')}</blockquote>`);
      continue;
    }

    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1].replace(/\t/g, '  ').length;
      const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${tag}><li>`);
        listStack.push({ indent, tag });
      } else {
        closeLists(indent);
        const cur = listStack[listStack.length - 1];
        if (cur && cur.indent === indent && cur.tag === tag) out.push('</li><li>');
        else {
          if (cur && cur.indent === indent) out.push(`</li></${listStack.pop()?.tag}>`);
          out.push(`<${tag}><li>`);
          listStack.push({ indent, tag });
        }
      }
      out.push(inlineHtml(li[3]));
      continue;
    }

    // A non-list line: continuation of the current list item if indented, otherwise a paragraph.
    if (listStack.length && /^\s+\S/.test(line)) {
      out.push(`<br>${inlineHtml(line.trim())}`);
      continue;
    }
    closeLists();
    para.push(line.trim());
  }
  flushPara();
  closeLists();
  return out.join('\n');
}

/** Complete, self-contained HTML document (inline CSS, no scripts, no external resources). */
export function reportToHtml(markdown: string, title: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${CSS}</style>`,
    '</head><body>',
    markdownToHtmlBody(markdown),
    '</body></html>',
  ].join('\n');
}
