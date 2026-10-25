/**
 * Builds the AI provider Qivra uses: the model configured on this phone (Settings → AI models,
 * normally the user's own Groq key), with consent for sending content to an external provider.
 * There is no server: the phone calls the provider directly over HTTPS.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { createOpenAICompatProvider, type ChatProvider, type StreamFetchLike } from '../core/ai/provider';
import { checkServerUrl, isPrivateHost } from '../core/net';
import { getSecret, SECRET_KEYS } from './secure';
import { getSettings } from './settings';

export interface ProviderState {
  provider: ChatProvider | null;
  /** Human-readable reason when no provider is usable. */
  reason: string | null;
  external: boolean;
  embeddingModel: string | null;
}

export interface AiInfo {
  enabled: boolean;
  model: string | null;
  /** e.g. "api.groq.com" or the phone's endpoint URL. */
  where: string | null;
  autoEnrich: boolean;
  embeddingModel: string | null;
}

// expo/fetch exposes the response body as a stream, which React Native's fetch does not.
const streamFetch = expoFetch as unknown as StreamFetchLike;

/** Free Gemini embeddings through Google's OpenAI-compatible endpoint (optional key in Settings → AI models). */
export const GEMINI_EMBED = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-embedding-001' };

const NONE = 'No AI model is configured (Settings → AI models). Answers use your saved items only.';

/** What the UI and the job planner need to know, without building a provider. */
export async function aiInfo(): Promise<AiInfo> {
  const s = await getSettings();
  // An embeddings-only key (Gemini) takes over embeddings from whichever chat provider is used.
  const embed = s.ai.embed?.enabled && s.ai.embed.model ? s.ai.embed.model : null;
  if (s.ai.enabled && s.ai.baseUrl && s.ai.model) {
    return { enabled: true, model: s.ai.model, where: s.ai.baseUrl, autoEnrich: s.ai.autoEnrich, embeddingModel: embed ?? (s.ai.embeddingModel || null) };
  }
  return { enabled: false, model: null, where: null, autoEnrich: false, embeddingModel: embed };
}

/** The provider that makes embeddings: the optional embeddings key first, else the chat provider's embedding model. */
export async function loadEmbedder(): Promise<{ provider: ChatProvider | null; embeddingModel: string | null; reason: string | null }> {
  const e = (await getSettings()).ai.embed;
  if (e?.enabled && e.baseUrl && e.model) {
    const apiKey = await getSecret(SECRET_KEYS.embedApiKey);
    if (apiKey) {
      try {
        return { provider: createOpenAICompatProvider({ baseUrl: e.baseUrl, model: e.model, apiKey, embeddingModel: e.model, label: `embeddings · ${e.model}` }), embeddingModel: e.model, reason: null };
      } catch (err) {
        return { provider: null, embeddingModel: null, reason: (err as Error).message };
      }
    }
  }
  const p = await loadProvider();
  return { provider: p.provider, embeddingModel: p.embeddingModel, reason: p.reason };
}

async function phoneProvider(): Promise<ProviderState | null> {
  const s = await getSettings();
  if (!s.ai.enabled || !s.ai.baseUrl || !s.ai.model) return null;
  const base = { embeddingModel: s.ai.embeddingModel || null };
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
    }, undefined, streamFetch);
    return { ...base, provider, reason: null, external };
  } catch (e) {
    return { ...base, provider: null, reason: (e as Error).message, external };
  }
}

export async function loadProvider(): Promise<ProviderState> {
  const phone = await phoneProvider();
  if (phone) return phone;
  return { provider: null, reason: NONE, external: false, embeddingModel: null };
}
