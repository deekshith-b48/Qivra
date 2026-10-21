/** Connects the grounded agent to the local database and the configured model. */

import { runAgent, type AgentData, type AgentResult, type EvidenceChunk, type EvidenceItem } from '../core/agent/agent';
import { askItem, type ItemQaResult, type ItemQaSource } from '../core/agent/itemQa';
import { ARTICLE_SOURCES } from '../core/url';
import { cosine } from '../core/search';
import type { Repo } from '../db/repo';
import type { ChunkHit, Item } from '../db/types';
import { loadProvider } from './ai';
import { getRepo } from './db';
import { emit } from './events';
import { getSettings } from './settings';

export function toEvidence(i: Item): EvidenceItem {
  return {
    id: i.id, title: i.title, url: i.url, sourceType: i.sourceType, capturedAt: i.capturedAt, summary: i.summary, note: i.note, tags: i.tags,
    tools: i.enrichment?.tools ?? [], repos: i.enrichment?.repos ?? [], commands: i.enrichment?.commands ?? [], keyPoints: i.enrichment?.keyPoints ?? [],
  };
}

const toChunk = (c: ChunkHit): EvidenceChunk => ({ chunkId: c.chunkId, itemId: c.itemId, transcriptId: c.transcriptId, kind: c.kind, text: c.text, startMs: c.startMs, language: c.language });

export async function agentData(repo: Repo): Promise<AgentData> {
  const { provider, embeddingModel } = await loadProvider();
  const data: AgentData = {
    searchChunks: async (q, opts) => (await repo.searchChunks(q, { itemIds: opts?.itemIds, limit: opts?.limit })).map(toChunk),
    itemsInRange: async (a, b) => (await repo.itemsInRange(a, b, 200)).map(toEvidence),
    getItems: async (ids) => (await repo.itemsByIds(ids)).map(toEvidence),
    chunksForItems: async (ids, per) => (await repo.chunksForItems(ids, per)).map(toChunk),
  };
  if (provider?.embed && embeddingModel) {
    data.semanticSearch = async (q, limit) => {
      const [qv] = await provider.embed!([q]);
      const all = await repo.allEmbeddings(embeddingModel);
      const top = all.map((e) => ({ e, score: cosine(qv, e.vector) })).sort((a, b) => b.score - a.score).slice(0, limit);
      const out: EvidenceChunk[] = [];
      for (const t of top) {
        const c = await repo.getChunk(t.e.chunkId);
        if (c) out.push(toChunk(c));
      }
      return out;
    };
  }
  return data;
}

/** Live progress for a streamed answer (Ask screen). */
export interface AskStream {
  onDelta?: (text: string) => void;
  onRoundReset?: () => void;
  onStatus?: (status: 'searching' | 'writing') => void;
  /** Aborting stops generation; the partial answer is kept and marked as stopped. */
  signal?: AbortSignal;
  /** Called once the user message is stored, so the conversation shows it immediately. */
  onConversation?: (conversationId: string) => void;
}

const STOPPED_NOTE = '\n\n_(stopped)_';

export async function ask(conversationId: string | null, question: string, stream: AskStream = {}): Promise<{ conversationId: string; result: AgentResult }> {
  const repo = await getRepo();
  const s = await getSettings();
  const convId = conversationId ?? (await repo.createConversation(question.slice(0, 80)));
  const history = (await repo.listMessages(convId)).slice(-6).map((m) => ({ role: m.role, content: m.content }));
  await repo.addMessage({ conversationId: convId, role: 'user', content: question, mode: null, provider: null, warnings: [], proposals: [], citations: [] });
  emit('conversations');
  stream.onConversation?.(convId);
  const { provider, reason } = await loadProvider();
  let partial = '';
  let result: AgentResult;
  try {
    stream.onStatus?.('searching');
    result = await runAgent(question, await agentData(repo), {
      now: Date.now(), timezone: s.timezone, provider, providerUnavailableReason: reason ?? undefined, history,
      onDelta: stream.onDelta ? (t) => { partial += t; stream.onDelta!(t); } : undefined,
      onRoundReset: () => { partial = ''; stream.onRoundReset?.(); },
      onStatus: stream.onStatus, signal: stream.signal,
    });
  } catch (e) {
    if (!stream.signal?.aborted) throw e;
    // Stopped by the user: keep what was written so far.
    result = { mode: 'model', answer: (partial.trim() || 'Stopped before an answer was written.') + STOPPED_NOTE, sources: [], citedIds: [], warnings: [], proposals: [], provider: provider?.label ?? null, toolTrace: [], usage: null };
  }
  if (result.usage && result.provider) await repo.addUsage({ provider: result.provider, model: provider?.model ?? null, kind: 'agent', ...result.usage });
  await repo.addMessage({
    conversationId: convId, role: 'assistant', content: result.answer, mode: result.mode, provider: result.provider, warnings: result.warnings, proposals: result.proposals,
    citations: result.sources.filter((src) => result.mode !== 'model' || result.citedIds.includes(src.sid)).map((src) => ({
      sid: src.sid, itemId: src.itemId, transcriptId: src.transcriptId, chunkId: src.chunkId, startMs: src.startMs, quote: src.quote,
    })),
  });
  emit('conversations');
  return { conversationId: convId, result };
}

/** The single item an "Ask this item" conversation is about, as untrusted source text. */
async function itemSource(repo: Repo, itemId: string): Promise<{ src: ItemQaSource; transcriptId: string | null } | null> {
  const item = await repo.getItem(itemId);
  if (!item || item.deleted) return null;
  const transcripts = (await repo.listTranscripts(itemId)).filter((t) => t.kind === 'original');
  const speech = transcripts.find((t) => !ARTICLE_SOURCES.has(t.source));
  const main = speech ?? transcripts[0] ?? null;
  const segs = main ? await repo.getSegments(main.id) : [];
  const meta = item.metadata as (Item['metadata'] & { bodyText?: string }) | null;
  const body = [main && !speech ? main.text : '', meta?.description ?? '', meta?.bodyText ?? ''].filter(Boolean).join('\n\n');
  return {
    transcriptId: main?.id ?? null,
    src: {
      title: item.title || item.url || 'Untitled', url: item.url, summary: item.summary, note: item.note, body,
      timed: speech ? segs.map((sg) => ({ startMs: sg.startMs, text: sg.text })) : [],
    },
  };
}

/** "Ask this item": a conversation scoped to one saved video, post or page, citing its moments. */
export async function askAboutItem(conversationId: string | null, itemId: string, question: string, stream: AskStream = {}): Promise<{ conversationId: string; result: ItemQaResult }> {
  const repo = await getRepo();
  const found = await itemSource(repo, itemId);
  if (!found) throw new Error('This item no longer exists.');
  const convId = conversationId ?? (await repo.createConversation(`About: ${found.src.title}`.slice(0, 80)));
  const history = (await repo.listMessages(convId)).slice(-6).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  await repo.addMessage({ conversationId: convId, role: 'user', content: question, mode: null, provider: null, warnings: [], proposals: [], citations: [] });
  emit('conversations');
  stream.onConversation?.(convId);
  const { provider } = await loadProvider();
  let partial = '';
  let result: ItemQaResult;
  try {
    stream.onStatus?.('writing');
    result = await askItem(found.src, question, provider, history, {
      onDelta: stream.onDelta ? (t) => { partial += t; stream.onDelta!(t); } : undefined, signal: stream.signal,
    });
  } catch (e) {
    if (!stream.signal?.aborted) throw e;
    result = { mode: 'model', answer: (partial.trim() || 'Stopped before an answer was written.') + STOPPED_NOTE, moments: [], provider: provider?.label ?? null, usage: null };
  }
  if (result.usage && result.provider) await repo.addUsage({ provider: result.provider, model: provider?.model ?? null, kind: 'agent', ...result.usage });
  await repo.addMessage({
    conversationId: convId, role: 'assistant', content: result.answer, mode: result.mode, provider: result.provider, warnings: [], proposals: [],
    citations: result.moments.map((m) => ({ sid: m.sid, itemId, transcriptId: m.startMs !== null ? found.transcriptId : null, chunkId: null, startMs: m.startMs, quote: m.quote })),
  });
  emit('conversations');
  return { conversationId: convId, result };
}

/** Regenerate: remove the last exchange (its question and answer) so it can be asked again. Returns the question. */
export async function dropLastExchange(conversationId: string): Promise<string | null> {
  const repo = await getRepo();
  const msgs = await repo.listMessages(conversationId);
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  if (!lastUser) return null;
  const from = msgs.indexOf(lastUser);
  const ids = msgs.slice(from).map((m) => m.id);
  await repo.db.transaction(async (tx) => {
    for (const id of ids) {
      await tx.run('DELETE FROM message_citations WHERE message_id = ?', [id]);
      await tx.run('DELETE FROM messages WHERE id = ?', [id]);
    }
  });
  emit('conversations');
  return lastUser.content;
}
