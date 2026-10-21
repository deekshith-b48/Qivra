import { createOpenAICompatProvider, createSseParser, type StreamFetchLike } from '../../src/core/ai/provider';

const enc = new TextEncoder();

function fakeStream(chunks: string[], status = 200): { fetch: StreamFetchLike; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: StreamFetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    let i = 0;
    return {
      ok: status < 400, status, text: async () => '',
      body: {
        getReader: () => ({
          read: async () => {
            if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            return i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true };
          },
          cancel: async () => undefined,
        }),
      },
    };
  };
  return { fetch, calls };
}

const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

test('the SSE parser copes with events split anywhere', () => {
  const parse = createSseParser();
  const whole = `${ev({ a: 1 })}${ev({ b: 2 })}data: [DONE]\n\n`;
  const out: unknown[] = [];
  let done = false;
  for (let k = 0; k < whole.length; k += 7) {
    const r = parse(whole.slice(k, k + 7));
    out.push(...r.events);
    done = r.done;
  }
  expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  expect(done).toBe(true);
});

test('chatStream delivers text as it arrives and returns the full answer', async () => {
  const body = `${ev({ model: 'gpt-oss', choices: [{ delta: { content: 'Hel' } }] })}${ev({ choices: [{ delta: { content: 'lo [S1]' } }] })}data: [DONE]\n\n`;
  const { fetch, calls } = fakeStream([body.slice(0, 30), body.slice(30, 61), body.slice(61)]);
  const p = createOpenAICompatProvider({ baseUrl: 'http://192.168.1.2:5001/api/v1/ai', model: 'm', apiKey: 'qv1_x' }, undefined, fetch);
  const seen: string[] = [];
  const r = await p.chatStream!([{ role: 'user', content: 'hi' }], {}, (t) => seen.push(t));
  expect(seen.join('')).toBe('Hello [S1]');
  expect(seen.length).toBe(2);
  expect(r).toMatchObject({ content: 'Hello [S1]', model: 'gpt-oss', toolCalls: [] });
  expect(calls[0]).toMatchObject({ url: 'http://192.168.1.2:5001/api/v1/ai/chat/completions', body: { stream: true, model: 'm' } });
});

test('streamed tool calls are reassembled from fragments', async () => {
  const { fetch } = fakeStream([
    ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_', arguments: '{"que' } }] } }] }),
    ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'library', arguments: 'ry":"hooks"}' } }] } }] }),
    'data: [DONE]\n\n',
  ]);
  const p = createOpenAICompatProvider({ baseUrl: 'http://192.168.1.2:5001/v1', model: 'm' }, undefined, fetch);
  const r = await p.chatStream!([{ role: 'user', content: 'x' }], {}, () => undefined);
  expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'search_library', arguments: '{"query":"hooks"}' }]);
});

test('an error event mid-stream and HTTP errors become provider errors; abort stops', async () => {
  const bad = createOpenAICompatProvider({ baseUrl: 'http://192.168.1.2:5001/v1', model: 'm' }, undefined, fakeStream([ev({ choices: [{ delta: { content: 'a' } }] }), ev({ error: { code: 'AI_STREAM_INTERRUPTED', message: 'gone' } })]).fetch);
  await expect(bad.chatStream!([{ role: 'user', content: 'x' }], {}, () => undefined)).rejects.toMatchObject({ code: 'SERVER' });
  const limited = createOpenAICompatProvider({ baseUrl: 'http://192.168.1.2:5001/v1', model: 'm' }, undefined, fakeStream([], 429).fetch);
  await expect(limited.chatStream!([{ role: 'user', content: 'x' }], {}, () => undefined)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  const ctl = new AbortController();
  ctl.abort();
  const p = createOpenAICompatProvider({ baseUrl: 'http://192.168.1.2:5001/v1', model: 'm' }, undefined, fakeStream([ev({ choices: [{ delta: { content: 'a' } }] })]).fetch);
  await expect(p.chatStream!([{ role: 'user', content: 'x' }], { signal: ctl.signal }, () => undefined)).rejects.toMatchObject({ message: 'Stopped.' });
});
