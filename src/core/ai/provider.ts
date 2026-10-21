/**
 * Interchangeable AI provider interface + an OpenAI-compatible adapter.
 *
 * One adapter covers every free/open option the user can point Qivra at:
 * Ollama (http://<laptop>:11434/v1), LM Studio, llama.cpp server, vLLM, and —
 * with the user's own key — Groq, OpenRouter, Gemini's OpenAI endpoint, etc.
 * No provider is bundled or required. Keys live in Android Keystore-backed
 * storage and are never logged.
 */

import { checkServerUrl, isPrivateHost } from '../net';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

export interface ChatOptions {
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatProvider {
  readonly label: string; // e.g. "ollama · llama3.2"
  readonly model: string;
  readonly local: boolean; // true when the endpoint is on the user's own network
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** Same as chat(), but calls onDelta with each piece of text as the model writes it. */
  chatStream?(messages: ChatMessage[], opts: ChatOptions, onDelta: (text: string) => void): Promise<ChatResult>;
  embed?(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export class ProviderError extends Error {
  constructor(public code: 'NOT_CONFIGURED' | 'NETWORK' | 'TIMEOUT' | 'AUTH' | 'RATE_LIMIT' | 'BAD_RESPONSE' | 'SERVER' | 'URL_REFUSED', message: string, public retryable = false) {
    super(message);
  }
}

export interface OpenAICompatConfig {
  baseUrl: string; // e.g. http://192.168.1.10:11434/v1 or https://api.groq.com/openai/v1
  model: string;
  apiKey?: string | null;
  embeddingModel?: string | null;
  timeoutMs?: number;
  label?: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** A fetch whose response body can be read incrementally (expo/fetch on the phone). */
export type StreamFetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> } } | null;
  text(): Promise<string>;
}>;

interface StreamToolCall { id: string; name: string; arguments: string }

/**
 * Incremental parser for OpenAI-style server-sent events. Feed it text as it
 * arrives (chunks may split lines or events anywhere); it returns the parsed
 * `data:` payloads and keeps the remainder for the next call.
 */
export function createSseParser(): (chunk: string) => { events: unknown[]; done: boolean } {
  let buf = '';
  let finished = false;
  return (chunk: string) => {
    buf += chunk;
    const events: unknown[] = [];
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') finished = true;
        else if (data) {
          try {
            events.push(JSON.parse(data));
          } catch {
            /* ignore keep-alives and partial garbage */
          }
        }
      }
      nl = buf.indexOf('\n');
    }
    return { events, done: finished };
  };
}

export function createOpenAICompatProvider(cfg: OpenAICompatConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike, streamFetch?: StreamFetchLike): ChatProvider {
  const check = checkServerUrl(cfg.baseUrl);
  if (!check.ok) throw new ProviderError('URL_REFUSED', check.message);
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const ctl = new AbortController();
    if (signal?.aborted) throw new ProviderError('TIMEOUT', 'Stopped.', false);
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    signal?.addEventListener('abort', () => ctl.abort());
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      throw new ProviderError(aborted ? 'TIMEOUT' : 'NETWORK', aborted ? 'The AI provider timed out.' : 'Could not reach the AI provider.', true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError('AUTH', 'The AI provider rejected the API key.');
    if (res.status === 429) throw new ProviderError('RATE_LIMIT', 'The AI provider rate limit was reached.', true);
    if (!res.ok) throw new ProviderError('SERVER', `The AI provider returned HTTP ${res.status}.`, res.status >= 500);
    try {
      return await res.json();
    } catch {
      throw new ProviderError('BAD_RESPONSE', 'The AI provider returned invalid JSON.');
    }
  }

  function chatBody(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: cfg.model,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2500, // reasoning models need room to think before answering
      messages: messages.map((m) =>
        m.role === 'tool'
          ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
          : m.toolCalls?.length
            ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) }
            : { role: m.role, content: m.content },
      ),
    };
    if (opts.tools?.length) body.tools = opts.tools.map((t) => ({ type: 'function', function: t }));
    return body;
  }

  const provider: ChatProvider = {
    label: cfg.label ?? `${check.url.host} · ${cfg.model}`,
    model: cfg.model,
    local: isPrivateHost(check.url.hostname),
    async chat(messages, opts = {}) {
      const body = chatBody(messages, opts);
      const data = (await post('/chat/completions', body, opts.signal)) as {
        model?: string;
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new ProviderError('BAD_RESPONSE', 'The AI provider returned no message.');
      return {
        content: msg.content ?? '',
        toolCalls: (msg.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
        model: data.model ?? cfg.model,
        usage: { promptTokens: data.usage?.prompt_tokens ?? null, completionTokens: data.usage?.completion_tokens ?? null },
      };
    },
  };
  if (streamFetch) {
    provider.chatStream = async (messages, opts, onDelta) => {
      const ctl = new AbortController();
      let timer = setTimeout(() => ctl.abort(), timeoutMs);
      // The timeout restarts with every chunk: a long answer that keeps arriving is fine.
      const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), timeoutMs); };
      // A signal that is already aborted never fires 'abort' again: check it up front.
      if (opts.signal?.aborted) {
        clearTimeout(timer);
        throw new ProviderError('TIMEOUT', 'Stopped.', false);
      }
      opts.signal?.addEventListener('abort', () => ctl.abort());
      let res: Awaited<ReturnType<StreamFetchLike>>;
      try {
        res = await streamFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({ ...chatBody(messages, opts), stream: true }),
          signal: ctl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (opts.signal?.aborted) throw new ProviderError('TIMEOUT', 'Stopped.', false);
        const aborted = (e as { name?: string })?.name === 'AbortError';
        throw new ProviderError(aborted ? 'TIMEOUT' : 'NETWORK', aborted ? 'The AI provider timed out.' : 'Could not reach the AI provider.', true);
      }
      if (!res.ok || !res.body) {
        clearTimeout(timer);
        if (res.status === 401 || res.status === 403) throw new ProviderError('AUTH', 'The AI provider rejected the API key.');
        if (res.status === 429) throw new ProviderError('RATE_LIMIT', 'The AI provider rate limit was reached.', true);
        throw new ProviderError('SERVER', `The AI provider returned HTTP ${res.status}.`, res.status >= 500);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parse = createSseParser();
      let content = '';
      let model = cfg.model;
      const calls: StreamToolCall[] = [];
      let usage: ChatResult['usage'] = { promptTokens: null, completionTokens: null };
      try {
        while (true) {
          if (ctl.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const { done, value } = await reader.read();
          if (done) break;
          bump();
          const { events, done: finished } = parse(decoder.decode(value, { stream: true }));
          for (const ev of events as {
            model?: string; error?: { message?: string };
            choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          }[]) {
            if (ev.error) throw new ProviderError('SERVER', ev.error.message ?? 'The AI provider stopped responding.', true);
            if (ev.model) model = ev.model;
            if (ev.usage) usage = { promptTokens: ev.usage.prompt_tokens ?? null, completionTokens: ev.usage.completion_tokens ?? null };
            const delta = ev.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              onDelta(delta.content);
            }
            for (const tc of delta?.tool_calls ?? []) {
              const i = tc.index ?? 0;
              calls[i] ??= { id: '', name: '', arguments: '' };
              if (tc.id) calls[i].id = tc.id;
              if (tc.function?.name) calls[i].name += tc.function.name;
              if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
            }
          }
          if (finished) break;
        }
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (opts.signal?.aborted) throw new ProviderError('TIMEOUT', 'Stopped.', false);
        const aborted = (e as { name?: string })?.name === 'AbortError';
        throw new ProviderError(aborted ? 'TIMEOUT' : 'NETWORK', aborted ? 'The AI provider timed out.' : 'The connection to the AI provider was lost.', true);
      } finally {
        clearTimeout(timer);
        void reader.cancel?.().catch(() => undefined);
      }
      return { content, toolCalls: calls.filter(Boolean).map((t, i) => ({ id: t.id || `call_${i}`, name: t.name, arguments: t.arguments })), model, usage };
    };
  }
  if (cfg.embeddingModel) {
    provider.embed = async (texts, signal) => {
      const data = (await post('/embeddings', { model: cfg.embeddingModel, input: texts }, signal)) as { data?: { embedding: number[]; index: number }[] };
      if (!data.data || data.data.length !== texts.length) throw new ProviderError('BAD_RESPONSE', 'Embedding response size mismatch.');
      return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    };
  }
  return provider;
}
