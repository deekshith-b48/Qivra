/** Citation validation: the model may only cite sources it was actually given. */

const CITE_RE = /\[S(\d+)\]/g;

/**
 * Models write citations in many shapes: 【S1】, [S1, S3], [S1; S2], (S2), [ S4 ].
 * Normalise them all to separate `[S1]` markers before validation and rendering.
 */
export function normalizeCitations(text: string): string {
  return text
    .replace(/【\s*([^】]*?)\s*】/g, (_m, inner: string) => `[${inner}]`)
    .replace(/[\[(]\s*(S\d+(?:\s*[,;&]\s*(?:and\s+)?S\d+)*)\s*[\])]/g, (_m, list: string) =>
      list.split(/\s*[,;&]\s*(?:and\s+)?/).map((sid) => `[${sid.trim()}]`).join(''));
}

export interface CitationCheck {
  text: string;
  cited: string[]; // ordered, unique source ids actually cited
  warnings: string[];
}

export function validateCitations(answer: string, validIds: string[]): CitationCheck {
  const valid = new Set(validIds);
  const cited: string[] = [];
  const warnings: string[] = [];
  const text = normalizeCitations(answer)
    .replace(CITE_RE, (m, n: string) => {
      const sid = `S${n}`;
      if (valid.has(sid)) {
        if (!cited.includes(sid)) cited.push(sid);
        return m;
      }
      warnings.push(`Removed a citation to ${sid}, which is not one of the provided sources.`);
      return '';
    })
    .replace(/[ \t]+([.,;:])/g, '$1')
    .trim();
  if (validIds.length && !cited.length) warnings.push('No saved item was cited, so this answer may not come from your library.');
  return { text, cited, warnings };
}

export function formatCitationLabel(sid: string, title: string, timestamp?: string): string {
  return `[${sid}] ${title}${timestamp ? ` @ ${timestamp}` : ''}`;
}
