import { parseTranslationBatch, translationMessages } from '../../src/core/translate';

test('translation batches must come back as exactly one English line per input line', () => {
  expect(parseTranslationBatch('Here you go:\n["Hello", " Today we learn RAG "]', 2)).toEqual(['Hello', 'Today we learn RAG']);
  expect(parseTranslationBatch('["only one"]', 2)).toBeNull(); // merged lines would shift every timestamp
  expect(parseTranslationBatch('["a", 3]', 2)).toBeNull();
  expect(parseTranslationBatch('not json [', 1)).toBeNull();
  const m = translationMessages(['नमस्ते', 'आज'], 'Hindi');
  expect(m[1].content).toContain('exactly 2 strings');
  expect(m[1].content).toContain('from Hindi');
});
