# Qivra architecture

```
 Android phone (React Native, Expo SDK 54)                    Laptop (optional)
 ┌──────────────────────────────────────────────┐             ┌─────────────────────────────────┐
 │ ShareActivity.kt ──► files/share_inbox/*.json │             │ python -m qivra serve [--lan]    │
 │        │ QivraShareTaskService (headless JS)   │   HTTP(S)   │  ├─ /api/health, /api/v1/* (qivra)│
 │ App.tsx ─ screens ─ ui                         │ ◄─────────► │  ├─ legacy SuperBrain routes      │
 │   services: capture · processing · server      │  Bearer     │  ├─ jobs thread (metadata,        │
 │            agent · reports · background        │  device     │  │   captions, Whisper, enrich)   │
 │   core: url share transcripts enrich search    │  credential │  └─ SQLite superbrain.db          │
 │         dates qr agent reports api ai          │             │      (analyses + qv_* tables)     │
 │   db: qivra.db (SQLite + FTS5)   sync engine   │             └─────────────────────────────────┘
 │   SecureStore (Keystore): device token, AI key │
 └──────────────────────────────────────────────┘
```

## Layers (app)

| Layer | Files | Rule |
|---|---|---|
| Core | `src/core/*` | Pure TypeScript, no React Native imports. Unit-tested in Node. |
| Data | `src/db/*` | `SqlDriver` interface; expo-sqlite on device, `node:sqlite` in tests — same SQL, same FTS5. |
| Sync | `src/sync/engine.ts` | Depends only on `Repo` + `QivraClient`; integration-tested against the real Python server. |
| Services | `src/services/*` | Device glue: file system, secure store, notifications, background task, job runner. |
| UI | `src/screens/*`, `src/ui/*`, `App.tsx` | Read via `useQuery` (re-runs on change events), write via services/repo. |

## Local data model (`qivra.db`, migration v1 in `src/db/schema.ts`)

`items` (stable id, source type, URL + dedupe key, title/note/summary with `summary_origin`, language + how it was determined, processing `status` + error, enrichment JSON, metadata JSON, timestamps, archived/deleted, `local_rev`/`synced_local_rev`/`server_revision`/`sync_status`) · `item_tags` · `collections` + `collection_items` · `transcripts` (unique per item/language/kind/source → retries never duplicate; originals and translations separate; `corrected` flag) + `transcript_segments` (ms timestamps or NULL) · `chunks` + `chunks_fts` (FTS5, unicode61, diacritics removed; maintained by triggers) · `embeddings` (optional) · `media` · `jobs` (durable queue) · `reports` · `conversations`/`messages`/`message_citations` · `conflicts` · `usage_events` · `meta` (settings, sync cursor, connection details).

Single user per device: ownership is the device itself; on the server every paired device belongs to the one local owner.

### Migrations

`PRAGMA user_version` tracks the schema; each migration runs in a transaction. A database newer than the app is refused (no silent downgrade). Shipped migrations are never edited; destructive changes must copy data into new tables first and keep the old table until a later release. Users can export everything (Settings → Privacy & storage) before upgrading.

## Processing pipeline

`CAPTURED → METADATA_CHECK → NEEDS_INPUT | TRANSCRIBING → ENRICHING → INDEXING → READY`, plus `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `CANCELLED` (`src/core/status.ts`; invalid transitions throw). Video/podcast items without a transcript stop at `NEEDS_INPUT` (still searchable by title/notes). Work items are rows in `jobs` with idempotent ids, atomic claiming, exponential backoff with jitter, max attempts, cancellation, and recovery of `running` jobs after process death.

Runners: app start/resume, after each capture, and a WorkManager periodic task (`expo-background-task`, ≥ 15 min, OS may defer under Doze/battery saver). Heavy work (Whisper, LLM enrichment) never runs on the phone's UI thread or in a server request handler.

## Agent

`src/core/agent/agent.ts`: deterministic plan (date intent in the user's timezone, topic terms, compare/repos/tools/plan/gaps intents) → read-only evidence gathering (FTS chunks, items by date, optional semantic search with reciprocal-rank fusion) → numbered sources → either a model answer (OpenAI-compatible tool calling limited to read tools; write tools become proposals) or a retrieval-only answer. Citations are validated against the provided sources.

## Native code added

Only `plugins/android/ShareActivity.kt` and `plugins/android/QivraShareTaskService.kt` (copied into `android/` by `plugins/withQivraAndroid.js` during `expo prebuild`). Share flow (1.4): `ShareActivity` writes the envelope, shows a toast and starts `QivraShareTaskService`, which runs the `QivraShare` headless task (`src/services/shareTask.ts`): drain the inbox, run jobs until each item is ready (including its AI summary) or ~150 s pass, then write `files/share_task/result-*.json` (`src/services/notify.ts`). The service runs in the foreground ("Preparing transcript and summary…", `dataSync` type) because Android freezes plain background services within seconds; it posts one notification per item from that result (tap → `qivra://item/<id>`, routed by React Navigation) and stops itself — React Native's own task-finished callback does not reach headless services under the New Architecture, and its 170 s timeout remains the backstop. Server jobs that cannot reach the laptop wait (`SERVER_UNREACHABLE`, no attempts used) and are woken when the server answers again. The user stays in the app they shared from; if the service cannot start, the app is opened with `qivra://share` as before. No custom React Native native modules; everything else uses maintained Expo modules (sqlite, secure-store, camera, document-picker, file-system, notifications, background-task, crypto, clipboard, localization, sharing, system-ui).

## Server

`server/qivra/`: `config` · `store` (qv_* tables, migrations, legacy mirror) · `pairing` (codes, credentials, rate limiter) · `security` (Host/Origin/size guards, auth) · `api_v1` · `jobs` · `knowledge` (retrieval, agent, reports) · `transcripts` · `metadata` · `ai` · `netinfo` · `__main__` (launcher). API contract: `docs/LOCAL_SERVER_AND_QR_PAIRING.md`.

## Supported Android versions

minSdk 24 (Android 7.0), target/compile SDK 36 (Expo SDK 54 defaults). Tested configuration is listed in `docs/TEST_RESULTS.md`.
