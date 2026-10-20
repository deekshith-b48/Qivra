/**
 * Minimal async SQL interface shared by the expo-sqlite adapter (device) and
 * the node:sqlite adapter (tests). All statements use bound parameters.
 */

export type SqlValue = string | number | null;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
}

export interface SqlDriver extends SqlExecutor {
  /** Runs `fn` atomically. Other callers are queued until it finishes. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Wraps a raw executor with a FIFO lock so a transaction on the single
 * connection is never interleaved with unrelated statements.
 */
export function serialDriver(raw: SqlExecutor, closeFn: () => Promise<void>): SqlDriver {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    exec: (sql) => enqueue(() => raw.exec(sql)),
    run: (sql, params) => enqueue(() => raw.run(sql, params)),
    all: (sql, params) => enqueue(() => raw.all(sql, params)),
    get: (sql, params) => enqueue(() => raw.get(sql, params)),
    transaction: (fn) =>
      enqueue(async () => {
        await raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(raw);
          await raw.exec('COMMIT');
          return result;
        } catch (e) {
          await raw.exec('ROLLBACK');
          throw e;
        }
      }),
    close: () => enqueue(closeFn),
  };
}
