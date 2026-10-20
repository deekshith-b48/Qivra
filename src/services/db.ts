/** Device database: expo-sqlite adapter + singleton repository. */

import * as SQLite from 'expo-sqlite';
import { serialDriver, type SqlDriver, type SqlExecutor, type SqlValue } from '../db/driver';
import { Repo } from '../db/repo';
import { migrate } from '../db/schema';

export const DB_NAME = 'qivra.db';

let repoPromise: Promise<Repo> | null = null;

function expoDriver(db: SQLite.SQLiteDatabase): SqlDriver {
  const raw: SqlExecutor = {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params: SqlValue[] = []) => {
      const r = await db.runAsync(sql, params);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
    },
    all: <T>(sql: string, params: SqlValue[] = []) => db.getAllAsync<T>(sql, params),
    get: async <T>(sql: string, params: SqlValue[] = []) => (await db.getFirstAsync<T>(sql, params)) ?? undefined,
  };
  return serialDriver(raw, () => db.closeAsync());
}

export function getRepo(): Promise<Repo> {
  if (!repoPromise) {
    repoPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      const driver = expoDriver(db);
      await migrate(driver);
      return new Repo(driver);
    })().catch((e) => {
      repoPromise = null;
      throw e;
    });
  }
  return repoPromise;
}
