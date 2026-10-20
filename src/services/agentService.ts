/** Connects the grounded agent to the local database and the configured model. */

import { runAgent, type AgentData, type AgentResult, type EvidenceChunk, type EvidenceItem } from '../core/agent/agent';
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
  const s = await getSettings();
  const { provider } = await loadProvider();
  const data: AgentData = {
    searchChunks: async (q, opts) => (await repo.searchChunks(q, { itemIds: opts?.itemIds, limit: opts?.limit })).map(toChunk),
    itemsInRange: async (a, b) => (await repo.itemsInRange(a, b, 200)).map(toEvidence),
    getItems: async (ids) => (await repo.itemsByIds(ids)).map(toEvidence),
    chunksForItems: async (ids, per) => (await repo.chunksForItems(ids, per)).map(toChunk),
  };
  if (provider?.embed && s.ai.embeddingModel) {
    data.semanticSearch = async (q, limit) => {
      const [qv] = await provider.embed!([q]);
      const all = await repo.allEmbeddings(s.ai.embeddingModel);
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

export async function ask(conversationId: string | null, question: string): Promise<{ conversationId: string; result: AgentResult }> {
  const repo = await getRepo();
  const s = await getSettings();
  const convId = conversationId ?? (await repo.createConversation(question.slice(0, 80)));
  const history = (await repo.listMessages(convId)).slice(-6).map((m) => ({ role: m.role, content: m.content }));
  await repo.addMessage({ conversationId: convId, role: 'user', content: question, mode: null, provider: null, warnings: [], proposals: [], citations: [] });
  const { provider, reason } = await loadProvider();
  const result = await runAgent(question, await agentData(repo), {
    now: Date.now(), timezone: s.timezone, provider, providerUnavailableReason: reason ?? undefined, history,
  });
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
