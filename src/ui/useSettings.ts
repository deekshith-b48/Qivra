import { useQuery } from './hooks';
import { getSettings, type Settings } from '../services/settings';
import { getConnection, type Connection } from '../services/server';
import { aiInfo, type AiInfo } from '../services/ai';

export function useSettings(): Settings | undefined {
  return useQuery(() => getSettings(), ['settings']).data;
}

export function useConnection(): { connection: Connection | null | undefined; reload: () => Promise<void> } {
  const q = useQuery(() => getConnection(), ['connection']);
  return { connection: q.data, reload: q.reload };
}

/** The AI Qivra will actually use: this phone's model, else the paired server's AI. */
export function useAiInfo(): AiInfo | undefined {
  return useQuery(() => aiInfo(), ['settings', 'connection']).data;
}
