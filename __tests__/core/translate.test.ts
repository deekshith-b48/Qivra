import { parseSummaryTranslation, parseTranslationBatch, summaryTranslationMessages, translationMessages } from '../../src/core/translate';

test('translation batches must come back as exactly one English line per input line', () => {
  expect(parseTranslationBatch('Here you go:\n["Hello", " Today we learn RAG "]', 2)).toEqual(['Hello', 'Today we learn RAG']);
  expect(parseTranslationBatch('["only one"]', 2)).toBeNull(); // merged lines would shift every timestamp
  expect(parseTranslationBatch('["a", 3]', 2)).toBeNull();
  expect(parseTranslationBatch('not json [', 1)).toBeNull();
  const m = translationMessages(['नमस्ते', 'आज'], 'Hindi');
  expect(m[1].content).toContain('exactly 2 strings');
  expect(m[1].content).toContain('from Hindi');
});

test('English lines into Kannada keep the count; summaries keep their moment times', () => {
  const m = translationMessages(['Hello', 'Today'], '', 'kn');
  expect(m[0].content).toContain('Kannada script');
  expect(m[1].content).toContain('into Kannada');
  const src = { tldr: 'RAG in one line.', summary: 'Longer.', moments: [{ text: 'Chunking', startMs: 31000 }, { text: 'Search', startMs: null }] };
  expect(JSON.parse(summaryTranslationMessages(src, 'ta')[1].content)).toEqual({ tldr: 'RAG in one line.', summary: 'Longer.', moments: ['Chunking', 'Search'] });
  expect(parseSummaryTranslation('Sure: {"tldr":" ಒಂದು ಸಾಲು ","summary":"ದೀರ್ಘ","moments":["ಚಂಕಿಂಗ್","ಹುಡುಕಾಟ"]}', src)).toEqual({
    tldr: 'ಒಂದು ಸಾಲು', summary: 'ದೀರ್ಘ', moments: [{ text: 'ಚಂಕಿಂಗ್', startMs: 31000 }, { text: 'ಹುಡುಕಾಟ', startMs: null }],
  });
  expect(parseSummaryTranslation('{"tldr":"a","summary":"b","moments":["only one"]}', src)).toBeNull();
  expect(parseSummaryTranslation('nope', src)).toBeNull();
});
