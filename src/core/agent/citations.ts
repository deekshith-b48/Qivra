/** Citation validation: the model may only cite sources it was actually given. */

const CITE_RE = /\[S(\d+)\]/g;

export interface CitationCheck {
  text: string;
  cited: string[]; // ordered, unique source ids actually cited
  warnings: string[];
}

export function validateCitations(answer: string, validIds: string[]): CitationCheck {
  const valid = new Set(validIds);
  const cited: string[] = [];
  const warnings: string[] = [];
  const text = answer
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
  if (validIds.length && !cited.length) warnings.push('This answer has no citations. Check it against the sources listed below.');
  return { text, cited, warnings };
}

export function formatCitationLabel(sid: string, title: string, timestamp?: string): string {
  return `[${sid}] ${title}${timestamp ? ` @ ${timestamp}` : ''}`;
}
