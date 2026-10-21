import { useQuery } from './hooks';
import { getSettings, type Settings } from '../services/settings';
import { getConnection, type Connection } from '../services/server';

export function useSettings(): Settings | undefined {
  return useQuery(() => getSettings(), ['settings']).data;
}

export function useConnection(): { connection: Connection | null | undefined; reload: () => Promise<void> } {
  const q = useQuery(() => getConnection(), ['connection']);
  return { connection: q.data, reload: q.reload };
}
