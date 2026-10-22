/**
 * Versioned, additive migrations for the on-device Qivra database (qivra.db).
 * Each migration runs inside a transaction and records `user_version`.
 * Never edit a shipped migration — append a new one. Destructive changes must
 * copy data forward first (see docs/ARCHITECTURE.md → "Migrations").
 */

import type { SqlDriver } from './driver';

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial qivra schema',
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  source_type      TEXT NOT NULL,
  url              TEXT,
  dedupe_key       TEXT,
  title            TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  author           TEXT NOT NULL DEFAULT '',
  site_name        TEXT NOT NULL DEFAULT '',
  thumbnail_url    TEXT NOT NULL DEFAULT '',
  summary          TEXT NOT NULL DEFAULT '',
  summary_origin   TEXT NOT NULL DEFAULT 'none',
  language         TEXT NOT NULL DEFAULT 'und',
  language_method  TEXT NOT NULL DEFAULT 'heuristic',
  status           TEXT NOT NULL DEFAULT 'CAPTURED',
  error_code       TEXT,
  error_message    TEXT,
  enrichment_json  TEXT,
  metadata_json    TEXT,
  origin           TEXT NOT NULL DEFAULT 'local',
  captured_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_viewed_at   TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  deleted          INTEGER NOT NULL DEFAULT 0,
  local_rev        INTEGER NOT NULL DEFAULT 1,
  synced_local_rev INTEGER NOT NULL DEFAULT 0,
  server_revision  INTEGER,
  sync_status      TEXT NOT NULL DEFAULT 'local_only'
);
CREATE INDEX IF NOT EXISTS idx_items_captured ON items (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_status ON items (status);
CREATE INDEX IF NOT EXISTS idx_items_source ON items (source_type);
CREATE INDEX IF NOT EXISTS idx_items_dedupe ON items (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_items_sync ON items (sync_status);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  origin  TEXT NOT NULL DEFAULT 'user',
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags (tag);

CREATE TABLE IF NOT EXISTS collections (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  icon             TEXT NOT NULL DEFAULT 'folder',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted          INTEGER NOT NULL DEFAULT 0,
  local_rev        INTEGER NOT NULL DEFAULT 1,
  synced_local_rev INTEGER NOT NULL DEFAULT 0,
  server_revision  INTEGER,
  sync_status      TEXT NOT NULL DEFAULT 'local_only'
);
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (collection_id, item_id)
);

CREATE TABLE IF NOT EXISTS transcripts (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  language        TEXT NOT NULL DEFAULT 'und',
  language_method TEXT NOT NULL DEFAULT 'heuristic',
  kind            TEXT NOT NULL DEFAULT 'original',
  source          TEXT NOT NULL,
  provider        TEXT,
  format          TEXT,
  text            TEXT NOT NULL,
  segment_count   INTEGER NOT NULL DEFAULT 0,
  has_timestamps  INTEGER NOT NULL DEFAULT 0,
  origin          TEXT NOT NULL DEFAULT 'local',
  corrected       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (item_id, language, kind, source)
);
CREATE TABLE IF NOT EXISTS transcript_segments (
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  start_ms      INTEGER,
  end_ms        INTEGER,
  text          TEXT NOT NULL,
  PRIMARY KEY (transcript_id, ordinal)
);

CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  text          TEXT NOT NULL,
  start_ms      INTEGER,
  end_ms        INTEGER,
  language      TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks (item_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id   INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  vector     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  uri         TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  item_id         TEXT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  run_after       TEXT NOT NULL,
  last_error_code TEXT,
  last_error      TEXT,
  payload_json    TEXT,
  result_json     TEXT,
  server_job_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_item ON jobs (item_id);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  range_start  TEXT NOT NULL,
  range_end    TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  markdown     TEXT NOT NULL,
  provider     TEXT,
  item_ids     TEXT NOT NULL DEFAULT '[]',
  filename     TEXT NOT NULL,
  exported_uri TEXT,
  exported_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  mode            TEXT,
  provider        TEXT,
  warnings_json   TEXT,
  proposals_json  TEXT,
  created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_citations (
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sid           TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  transcript_id TEXT,
  chunk_id      INTEGER,
  start_ms      INTEGER,
  quote         TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (message_id, sid)
);

CREATE TABLE IF NOT EXISTS conflicts (
  id              TEXT PRIMARY KEY,
  entity_kind     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  remote_json     TEXT NOT NULL,
  remote_revision INTEGER NOT NULL,
  detected_at     TEXT NOT NULL,
  resolved_at     TEXT,
  resolution      TEXT
);
CREATE INDEX IF NOT EXISTS idx_conflicts_open ON conflicts (resolved_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider          TEXT NOT NULL,
  model             TEXT,
  kind              TEXT NOT NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  created_at        TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'smart collections and flashcards',
    sql: `
ALTER TABLE collections ADD COLUMN rules_json TEXT;

CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  front         TEXT NOT NULL,
  back          TEXT NOT NULL,
  start_ms      INTEGER,
  due_at        TEXT NOT NULL,
  interval_days REAL NOT NULL DEFAULT 0,
  ease          REAL NOT NULL DEFAULT 2.5,
  reps          INTEGER NOT NULL DEFAULT 0,
  lapses        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  origin        TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards (due_at);
CREATE INDEX IF NOT EXISTS idx_cards_item ON cards (item_id);
`,
  },
  {
    version: 3,
    name: 'favourites, highlights and revisit reminders',
    sql: `
ALTER TABLE items ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN remind_at TEXT;
ALTER TABLE items ADD COLUMN remind_notification_id TEXT;

CREATE TABLE IF NOT EXISTS highlights (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  start_ms   INTEGER,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_item ON highlights (item_id);
CREATE INDEX IF NOT EXISTS idx_items_remind ON items (remind_at);
`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export async function migrate(db: SqlDriver): Promise<{ from: number; to: number }> {
  await db.exec('PRAGMA foreign_keys = ON');
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  const from = row?.user_version ?? 0;
  if (from > LATEST_VERSION) {
    throw new Error(`Database version ${from} is newer than this app (${LATEST_VERSION}). Update Qivra.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: LATEST_VERSION };
}
