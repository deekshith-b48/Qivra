/** Tiny change bus so screens refresh from the database after writes. */

export type Topic = 'items' | 'jobs' | 'reports' | 'collections' | 'connection' | 'settings' | 'conversations' | 'conflicts';

type Listener = (topic: Topic) => void;
const listeners = new Set<Listener>();

export function emit(...topics: Topic[]): void {
  for (const t of topics) for (const l of [...listeners]) l(t);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
