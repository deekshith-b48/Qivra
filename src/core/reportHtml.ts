/**
 * Report Markdown → self-contained HTML for PDF printing (expo-print).
 * Pure and dependency-free. Every piece of text is HTML-escaped; only the
 * tags produced here reach the output, and links are limited to http(s)/mailto.
 * Supports what reports use: headings, nested lists, quotes, tables, fenced
 * code, bold, italics, inline code and links. `reportToHtml` lays a report out
 * as a title block, stat row, sections and source cards (see `splitReport`).
 */

import { sourceBlocks, splitReport } from './reports';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s"'<>]+$/i;

function emphasis(text: string): string {
  // `text` is already escaped; markers are plain ASCII so they survive escaping.
  return text
    .replace(/\[(S\d+)\]/g, '<span class="cite">$1</span>')
    .replace(/\[((?:\d+:)?\d{1,3}:\d{2})\]/g, '<span class="ts">$1</span>')
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
@page { margin: 16mm 15mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: -apple-system, Roboto, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1c1c1e; background: #fff; margin: 0; }
header.title { margin-bottom: 14pt; }
h1 { font-size: 19pt; line-height: 1.25; margin: 0 0 4pt; letter-spacing: -0.2pt; }
.meta { color: #6e6e73; font-size: 9.5pt; }
.meta p { margin: 0; }
.stats { display: flex; flex-wrap: wrap; gap: 6pt; margin-top: 10pt; }
.stat { background: #f2f2f7; border-radius: 8pt; padding: 5pt 10pt; min-width: 64pt; }
.stat b { display: block; font-size: 14pt; line-height: 1.2; }
.stat span { color: #6e6e73; font-size: 8.5pt; }
section { margin-top: 14pt; }
h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 0.8pt; color: #6e6e73; margin: 0 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #e5e5ea; page-break-after: avoid; }
h3 { font-size: 11.5pt; margin: 10pt 0 4pt; page-break-after: avoid; }
h4, h5, h6 { font-size: 10.5pt; margin: 8pt 0 4pt; }
p { margin: 4pt 0; }
ul, ol { margin: 4pt 0; padding-left: 16pt; }
li { margin: 2pt 0; }
blockquote { margin: 6pt 0; padding: 3pt 9pt; border-left: 3px solid #c7c7cc; color: #6e6e73; font-size: 9.5pt; }
.src { border: 1px solid #e5e5ea; border-radius: 8pt; padding: 7pt 10pt; margin: 6pt 0; page-break-inside: avoid; }
.src p:first-child { margin-top: 0; font-weight: 600; }
.src ul { color: #3a3a3c; font-size: 9.5pt; }
.cite { display: inline-block; font-size: 7.5pt; font-weight: 700; color: #0a5cc2; background: #e8f0fc; border-radius: 4pt; padding: 0 4pt; vertical-align: 1pt; }
.src p:first-child .cite { font-size: 8pt; }
.ts { font-family: Menlo, Consolas, "Roboto Mono", monospace; font-size: 8.5pt; color: #6e6e73; background: #f2f2f7; border-radius: 3pt; padding: 0 3pt; }
code { font-family: Menlo, Consolas, "Roboto Mono", monospace; font-size: 9pt; background: #f2f2f7; padding: 0 3px; border-radius: 3px; }
pre { background: #f2f2f7; border-radius: 6pt; padding: 8pt; white-space: pre-wrap; word-break: break-word; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; page-break-inside: avoid; }
th, td { border: 1px solid #e5e5ea; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f2f2f7; }
a { color: #0a5cc2; text-decoration: none; word-break: break-word; }
hr { border: 0; border-top: 1px solid #e5e5ea; margin: 12pt 0; }
footer { margin-top: 18pt; padding-top: 6pt; border-top: 1px solid #e5e5ea; color: #8e8e93; font-size: 8.5pt; }
footer p { margin: 2pt 0; }
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

/** "_Today · 3 items_" + "**At a glance:** 1 video · 2 with transcripts" → stat chips. */
function statRow(preamble: string): { stats: string; rest: string } {
  const stats: string[] = [];
  const items = /(\d+) items?_?\s*$/m.exec(preamble);
  if (items) stats.push(`<div class="stat"><b>${items[1]}</b><span>${Number(items[1]) === 1 ? 'item' : 'items'}</span></div>`);
  const glance = /^\*\*At a glance:\*\* (.*)$/m.exec(preamble);
  for (const part of glance?.[1].split(' · ') ?? []) {
    const m = /^(\d+) (.+)$/.exec(part.trim());
    if (m) stats.push(`<div class="stat"><b>${m[1]}</b><span>${escapeHtml(m[2])}</span></div>`);
  }
  return { stats: stats.length ? `<div class="stats">${stats.join('')}</div>` : '', rest: glance ? preamble.replace(glance[0], '') : preamble };
}

/** Complete, self-contained HTML document (inline CSS, no scripts, no external resources). */
export function reportToHtml(markdown: string, title: string): string {
  const r = splitReport(markdown);
  const { stats, rest } = statRow(r.preamble);
  const sections = r.sections.map((s) => {
    const body = s.heading === 'By source' ? sourceBlocks(s.body).map((b) => `<div class="src">${markdownToHtmlBody(b)}</div>`).join('\n') : markdownToHtmlBody(s.body);
    return `<section><h2>${inlineHtml(s.heading)}</h2>\n${body}</section>`;
  });
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${CSS}</style>`,
    '</head><body>',
    `<header class="title"><h1>${inlineHtml(r.title || title)}</h1><div class="meta">${markdownToHtmlBody(rest)}</div>${stats}</header>`,
    ...sections,
    r.footer ? `<footer>${markdownToHtmlBody(r.footer)}</footer>` : '',
    '</body></html>',
  ].join('\n');
}
