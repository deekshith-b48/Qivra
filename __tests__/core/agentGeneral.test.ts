import { type AgentData, isSmallTalk, runAgent } from '../../src/core/agent/agent';
import type { ChatProvider } from '../../src/core/ai/provider';

const empty: AgentData = {
  searchChunks: async () => [], itemsInRange: async () => [], getItems: async () => [], chunksForItems: async () => [],
};
const opts = { now: Date.parse('2026-10-22T09:00:00Z'), timezone: 'UTC' };

function fakeProvider(reply: string) {
  const seen: { messages: { role: string; content: string }[] }[] = [];
  const p: ChatProvider = {
    label: 'Qivra server · api.groq.com · gpt-oss', model: 'gpt-oss', local: true,
    chat: async (messages) => { seen.push({ messages }); return { content: reply, toolCalls: [], model: 'gpt-oss', usage: { promptTokens: 1, completionTokens: 1 } }; },
  };
  return { p, seen };
}

test('small talk is recognised; real questions are not', () => {
  for (const q of ['Heyy', 'hi!', 'Hello there', 'good morning', 'thanks', 'thank you so much', 'who are you?', 'what can you do']) expect(isSmallTalk(q)).toBe(true);
  for (const q of ['hey what did I save about kubernetes yesterday', 'compare the github projects', 'hooks']) expect(isSmallTalk(q)).toBe(false);
});

test('"Heyy" gets a friendly reply, not "nothing found" (with and without a model)', async () => {
  const local = await runAgent('Heyy', empty, opts);
  expect(local.mode).toBe('general');
  expect(local.answer).toMatch(/Hi! 👋 I'm Qivra/);
  const { p, seen } = fakeProvider('Hey! I can answer questions about what you saved.');
  const r = await runAgent('Heyy', empty, { ...opts, provider: p });
  expect(r).toMatchObject({ mode: 'general', answer: 'Hey! I can answer questions about what you saved.', sources: [] });
  expect(seen[0].messages[0].content).toMatch(/small talk/);
});

test('General mode chats with the model, streams, and keeps history', async () => {
  const deltas: string[] = [];
  const p: ChatProvider = {
    label: 'gw', model: 'm', local: true,
    chat: async () => { throw new Error('should stream'); },
    chatStream: async (messages, _o, onDelta) => { onDelta('Paris'); onDelta('.'); expect(messages.at(-2)?.content).toBe('earlier answer'); return { content: 'Paris.', toolCalls: [], model: 'm', usage: { promptTokens: null, completionTokens: null } }; },
  };
  const r = await runAgent('What is the capital of France?', empty, { ...opts, provider: p, mode: 'general', onDelta: (t) => deltas.push(t), history: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'earlier answer' }] });
  expect(r).toMatchObject({ mode: 'general', answer: 'Paris.', sources: [] });
  expect(deltas.join('')).toBe('Paris.');
  const none = await runAgent('What is the capital of France?', empty, { ...opts, mode: 'general' });
  expect(none.mode).toBe('no_evidence');
  expect(none.answer).toMatch(/General chat needs an AI model/);
});

test('library mode with no matches offers to answer generally', async () => {
  const r = await runAgent('explain quantum tunnelling', empty, opts);
  expect(r.mode).toBe('no_evidence');
  expect(r.answer).toMatch(/Nothing in your saved library mentions "quantum tunnelling"/);
  expect(r.answer).toMatch(/answer generally/);
});
