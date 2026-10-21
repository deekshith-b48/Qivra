/**
 * Builds the AI provider Qivra uses, in this order:
 *  1. the model configured on this phone (Settings → AI models), with external-provider consent;
 *  2. otherwise the paired server's AI gateway: the server owner configured a provider and key
 *     in server/qivra.env, the phone calls it through the server with its device credential,
 *     and the provider key never reaches the phone.
 */

import { createOpenAICompatProvider, type ChatProvider } from '../core/ai/provider';
import { checkServerUrl, isPrivateHost } from '../core/net';
import { getSecret, SECRET_KEYS } from './secure';
import { checkConnection, getConnection } from './server';
import { getSettings } from './settings';

export type AiSource = 'phone' | 'server';

export interface ProviderState {
  provider: ChatProvider | null;
  /** Human-readable reason when no provider is usable. */
  reason: string | null;
  external: boolean;
  source: AiSource | null;
  embeddingModel: string | null;
}

export interface AiInfo {
  enabled: boolean;
  source: AiSource | null;
  model: string | null;
  /** e.g. "api.groq.com" or the phone's endpoint URL. */
  where: string | null;
  autoEnrich: boolean;
  embeddingModel: string | null;
}

const NONE = 'No AI model is configured (Settings → AI models). Answers use your saved items only.';

/** What the UI and the job planner need to know, without building a provider. */
export async function aiInfo(): Promise<AiInfo> {
  const s = await getSettings();
  if (s.ai.enabled && s.ai.baseUrl && s.ai.model) {
    return { enabled: true, source: 'phone', model: s.ai.model, where: s.ai.baseUrl, autoEnrich: s.ai.autoEnrich, embeddingModel: s.ai.embeddingModel || null };
  }
  const gw = (await getConnection())?.aiGateway;
  if (gw?.enabled && gw.model) {
    // The owner turned this on for the server, so new items get AI summaries automatically.
    return { enabled: true, source: 'server', model: gw.model, where: gw.upstream ?? 'your Qivra server', autoEnrich: true, embeddingModel: gw.embeddingModel ?? null };
  }
  return { enabled: false, source: null, model: null, where: null, autoEnrich: false, embeddingModel: null };
}

async function phoneProvider(): Promise<ProviderState | null> {
  const s = await getSettings();
  if (!s.ai.enabled || !s.ai.baseUrl || !s.ai.model) return null;
  const base = { source: 'phone' as const, embeddingModel: s.ai.embeddingModel || null };
  const check = checkServerUrl(s.ai.baseUrl);
  if (!check.ok) return { ...base, provider: null, reason: `AI endpoint rejected: ${check.message}`, external: false };
  const external = !isPrivateHost(check.url.hostname);
  if (external && !s.ai.externalConsent) {
    return { ...base, provider: null, reason: 'The configured AI provider is outside your network and you have not allowed sending content to it.', external };
  }
  const apiKey = await getSecret(SECRET_KEYS.aiApiKey);
  try {
    const provider = createOpenAICompatProvider({
      baseUrl: s.ai.baseUrl,
      model: s.ai.model,
      apiKey,
      embeddingModel: base.embeddingModel,
      label: `${check.url.hostname} · ${s.ai.model}`,
    });
    return { ...base, provider, reason: null, external };
  } catch (e) {
    return { ...base, provider: null, reason: (e as Error).message, external };
  }
}

async function serverProvider(): Promise<ProviderState | null> {
  let conn = await getConnection();
  if (!conn) return null;
  // Connections saved before the gateway existed have no aiGateway field yet: ask the server once.
  if (conn.aiGateway === undefined) conn = await checkConnection();
  const gw = conn?.aiGateway;
  if (!conn || !gw?.enabled || !gw.model) return null;
  const token = await getSecret(SECRET_KEYS.deviceToken);
  if (!token) return null;
  const embeddingModel = gw.embeddingModel ?? null;
  try {
    const provider = createOpenAICompatProvider({
      baseUrl: `${conn.serverUrl.replace(/\/+$/, '')}/api/v1/ai`,
      model: gw.model,
      apiKey: token,
      embeddingModel,
      timeoutMs: 120_000,
      label: `Qivra server · ${gw.upstream ?? 'AI'} · ${gw.model}`,
    });
    return { provider, reason: null, external: gw.external ?? true, source: 'server', embeddingModel };
  } catch (e) {
    return { provider: null, reason: (e as Error).message, external: gw.external ?? true, source: 'server', embeddingModel };
  }
}

export async function loadProvider(): Promise<ProviderState> {
  const phone = await phoneProvider();
  if (phone) return phone;
  const server = await serverProvider();
  if (server) return server;
  return { provider: null, reason: NONE, external: false, source: null, embeddingModel: null };
}
