/**
 * Small Markdown block parser for chat answers and reports. Pure, so it is unit
 * tested. Tolerates text that is still streaming in: an unclosed code fence is
 * shown as code so far, and a table appears once its separator row arrives.
 */

export type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: { text: string; indent: number; marker: string }[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; text: string; open: boolean }
  | { type: 'table'; header: string[]; align: ('left' | 'center' | 'right')[]; rows: string[][] }
  | { type: 'hr' };

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '\\' && l[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (l[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += l[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++]);
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n'), open: j >= lines.length });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Table: a row with pipes followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush();
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')) as ('left' | 'center' | 'right')[];
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
        const cells = splitRow(lines[j]);
        rows.push(header.map((_, k) => cells[k] ?? ''));
        j++;
      }
      blocks.push({ type: 'table', header, align: header.map((_, k) => align[k] ?? 'left'), rows });
      i = j - 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flush();
      blocks.push({ type: 'hr' });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      const q: string[] = [line.replace(/^\s*>\s?/, '')];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', text: q.join(' ') });
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items: { text: string; indent: number; marker: string }[] = [];
      let j = i;
      while (j < lines.length) {
        const m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[j]);
        if (m) {
          items.push({ text: m[3], indent: Math.min(3, Math.floor(m[1].length / 2)), marker: /\d/.test(m[2]) ? m[2].replace(')', '.') : '•' });
          j++;
        } else if (lines[j].trim() && /^\s{2,}\S/.test(lines[j]) && items.length) {
          items[items.length - 1].text += ` ${lines[j].trim()}`; // continuation line
          j++;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items });
      i = j - 1;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'strike'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'cite'; v: string }
  | { t: 'time'; v: string; ms: number };

const INLINE = /(\[(?:\d+:)?\d{1,3}:\d{2}\]|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|<https?:[^>\s]+>|\[S\d+\]|(?<![\w*])\*[^*\n]+\*(?!\w)|(?<![\w_])_[^_\n]+_(?!\w))/g;

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const p = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    last = at + p.length;
    if (p.startsWith('**') || p.startsWith('__')) out.push({ t: 'bold', v: p.slice(2, -2) });
    else if (p.startsWith('~~')) out.push({ t: 'strike', v: p.slice(2, -2) });
    else if (p.startsWith('`')) out.push({ t: 'code', v: p.slice(1, -1) });
    else if (/^\[S\d+\]$/.test(p)) out.push({ t: 'cite', v: p.slice(1, -1) });
    else if (/^\[[\d:]+\]$/.test(p)) {
      const parts = p.slice(1, -1).split(':').map(Number);
      const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      out.push({ t: 'time', v: p.slice(1, -1), ms: secs * 1000 });
    }
    else if (p.startsWith('<')) out.push({ t: 'link', v: p.slice(1, -1), href: p.slice(1, -1) });
    else if (p.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)!;
      if (/^https?:\/\//.test(lm[2])) out.push({ t: 'link', v: lm[1], href: lm[2] });
      else out.push({ t: 'text', v: lm[1] });
    } else out.push({ t: 'italic', v: p.slice(1, -1) });
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}
