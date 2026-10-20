/** node:sqlite adapter implementing the app's SqlDriver (tests only). */
import { webcrypto } from 'node:crypto';
import { serialDriver, type SqlDriver, type SqlExecutor, type SqlValue } from '../../src/db/driver';
import { setRandomSource } from '../../src/core/ids';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

setRandomSource((b) => webcrypto.getRandomValues(b));

export function openNodeDriver(path = ':memory:'): SqlDriver {
  const db = new DatabaseSync(path);
  const raw: SqlExecutor = {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params: SqlValue[] = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
  };
  return serialDriver(raw, async () => db.close());
}
