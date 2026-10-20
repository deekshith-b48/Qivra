/** Builds the configured AI provider, enforcing the external-provider consent. */

import { createOpenAICompatProvider, type ChatProvider } from '../core/ai/provider';
import { checkServerUrl, isPrivateHost } from '../core/net';
import { getSecret, SECRET_KEYS } from './secure';
import { getSettings } from './settings';

export interface ProviderState {
  provider: ChatProvider | null;
  /** Human-readable reason when no provider is usable. */
  reason: string | null;
  external: boolean;
}

export async function loadProvider(): Promise<ProviderState> {
  const s = await getSettings();
  if (!s.ai.enabled || !s.ai.baseUrl || !s.ai.model) {
    return { provider: null, reason: 'No AI model is configured (Settings → AI models). Answers use your saved items only.', external: false };
  }
  const check = checkServerUrl(s.ai.baseUrl);
  if (!check.ok) return { provider: null, reason: `AI endpoint rejected: ${check.message}`, external: false };
  const external = !isPrivateHost(check.url.hostname);
  if (external && !s.ai.externalConsent) {
    return { provider: null, reason: 'The configured AI provider is outside your network and you have not allowed sending content to it.', external };
  }
  const apiKey = await getSecret(SECRET_KEYS.aiApiKey);
  try {
    const provider = createOpenAICompatProvider({
      baseUrl: s.ai.baseUrl,
      model: s.ai.model,
      apiKey,
      embeddingModel: s.ai.embeddingModel || null,
      label: `${check.url.hostname} · ${s.ai.model}`,
    });
    return { provider, reason: null, external };
  } catch (e) {
    return { provider: null, reason: (e as Error).message, external };
  }
}
