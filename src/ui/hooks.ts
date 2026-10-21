/** Data hooks: load from the repo and re-run when relevant topics change. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { Repo } from '../db/repo';
import { getRepo } from '../services/db';
import { subscribe, type Topic } from '../services/events';

export function useQuery<T>(fn: (repo: Repo) => Promise<T>, topics: Topic[], deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const repo = await getRepo();
      const v = await fnRef.current(repo);
      if (alive.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message ?? String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const un = subscribe((t) => {
      if (!topics.includes(t)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 120); // coalesce bursts of writes
    });
    return () => {
      alive.current = false;
      un();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}

/** Wrap an async action with busy state and a user-visible error alert. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, errorTitle = 'Something went wrong'): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      Alert.alert(errorTitle, (e as Error)?.message ?? String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

export function confirm(title: string, message: string, confirmLabel = 'Confirm', destructive = false): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}
