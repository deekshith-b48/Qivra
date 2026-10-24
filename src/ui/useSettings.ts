import { useQuery } from './hooks';
import { getSettings, type Settings } from '../services/settings';
import { aiInfo, type AiInfo } from '../services/ai';

export function useSettings(): Settings | undefined {
  return useQuery(() => getSettings(), ['settings']).data;
}

/** The AI Qivra will use: the user's own key on this phone. */
export function useAiInfo(): AiInfo | undefined {
  return useQuery(() => aiInfo(), ['settings']).data;
}
