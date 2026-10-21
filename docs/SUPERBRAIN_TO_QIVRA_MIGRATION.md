# SuperBrain → Qivra migration

**Source:** `/Users/deekshi484/Downloads/superbrain-main` (SuperBrain v2.0.x snapshot, files dated 2026-09-01; upstream https://github.com/sidinsearch/superbrain). The folder had no git history of its own, so no upstream commit hash could be recorded; the unmodified copy is commit `cbc1f42` ("Import SuperBrain snapshot") in this repository and every change is visible as a diff against it.

**Layout:** `superbrain-app/` → repo root (React Native app), `backend/` → `server/`. `superbrain-cli/` (npm installer, MIT) and `superbrain-extension/` (Chrome extension) were not copied; they still work against the server's legacy routes (the extension needs its origin in `ALLOWED_ORIGINS`).

Status legend: **Retained** (kept as-is) · **Adapted** (kept, changed) · **Redesigned** · **Replaced** · **Deferred** · **Removed**.

## Feature inventory

| SuperBrain feature | Before (baseline) | Qivra | Status |
|---|---|---|---|
| Android share-sheet capture | `ShareActivity.kt` took `text/plain` only, regex-extracted the first Instagram URL, passed it in a deep link; nothing persisted before JS ran | `plugins/android/ShareActivity.kt`: SEND + SEND_MULTIPLE, text, SRT/VTT/TXT, audio/video; copies content URIs to private storage with size caps; writes a durable inbox envelope; JS validates (`src/core/share.ts`) | Redesigned · working (unit-tested; device-tested only if listed in TEST_RESULTS) |
| Instagram / YouTube / web link saving | Server-side only (`/analyze`); app useless without a server | Saved locally first; link normalisation ported from `core/link_checker.py` to `src/core/url.ts` (+GitHub, podcasts, tracking-param removal, dedupe keys) | Adapted · working |
| Metadata extraction | Server: instaloader captions, Gemini watching YouTube, newspaper4k/trafilatura | Device: YouTube oEmbed, GitHub API + README, Open Graph (`src/core/metadata.ts`). Server: SSRF-guarded HTML meta job (`server/qivra/metadata.py`). SuperBrain's full analyzers remain in `server/` | Adapted · working |
| AI summaries & enrichment | Server ModelRouter (Groq/Gemini/OpenRouter/Ollama), always via server | Local extractive enrichment always; optional on-device OpenAI-compatible provider; optional server enrichment job using SuperBrain's ModelRouter (`server/qivra/jobs.py`) | Redesigned · working (model paths need a configured provider) |
| Audio transcription (Groq Whisper / local Whisper) | `analyzers/audio_transcribe.py` inside `main.py` pipeline | Reused through an adapter (`jobs.transcribe_media`) for user-uploaded media; `transcribe_audio` itself returns `None`, so the adapter calls its `_transcribe_groq`/`_transcribe_local` | Adapted · needs Groq key or Whisper+ffmpeg on the server |
| Music identification (Shazam), visual frame analysis | In `main.py` pipeline | Untouched in `server/`; still used by the legacy `/analyze` queue; not surfaced in the Qivra app | Retained (server) · not exposed in app |
| Library, categories, tags | Server-backed list cached in `superbrain_local.db` + AsyncStorage | Local SQLite library with tags, filters, FTS5, list/grid, paging, bulk ops, archive | Redesigned · working |
| Collections (Watch Later, custom) | AsyncStorage + server `/collections` | Local tables, synced as `collection` entities; SuperBrain collections imported (`src/db/legacy.ts`) | Adapted · working |
| Search | `LIKE` on tags (server) / title-summary (app) | FTS5 over titles, notes, summaries, transcript chunks; optional embeddings (hybrid RRF) in the agent | Redesigned · working |
| Watch-later notifications (per-post, scheduled 8 am–9:30 pm) | `notificationService.ts` | Replaced by one optional daily review reminder; permission requested only when enabled | Replaced |
| Retry queue / failed analyses screens | Server retry queue + AsyncStorage lists | Durable on-device job queue with backoff + Processing queue screen; server jobs table | Redesigned · working |
| Data import/export (JSON/ZIP via server) | `/export`, `/import` | On-device JSON export through Storage Access Framework (verified after write); server routes still exist | Adapted |
| Local server start (`start.py`) | Wizard + uvicorn on `0.0.0.0` + ngrok/localtunnel + QR containing the permanent token | Wizard kept; launch hands off to `python -m qivra serve` (loopback default, `--lan` opt-in, no tunnels, one-time pairing QR) | Redesigned · working |
| Authentication | Single static 8-char token for everything, logged at startup, returned by unauthenticated `/connect-info`, accepted in query strings | Per-device revocable credentials (hashed), one-time pairing codes; legacy token kept for loopback only, never logged or disclosed | Replaced · working |
| Sync | `/sync?since=` delta by timestamp, last-write-wins | Revisioned entities, change feed, conflicts recorded and resolved by the user | Redesigned · working |
| AI provider key management in app | App sent keys to server `/settings/ai-providers` | Keys for server stay in `server/config/.api_keys` (set via `start.py`); on-device provider key in Keystore | Adapted |
| Instagram credential screen | App sent IG username/password to server | Not exposed in the Qivra app (sending a social-media password from phone to server over LAN HTTP is not acceptable); still configurable with `python start.py --reset` | Deferred |
| Expo web target, react-native-web | Present | Removed (Android-first) | Removed |
| Chrome extension | Separate | Unchanged, uses legacy routes | Retained (separate) |

## Reused SuperBrain code

- **Server, as-is:** `core/database.py` (SQLite + queue), `core/model_router.py`, `analyzers/*`, `instagram/*`, `main.py`, `config_settings.py`, `reset.py`, Docker files.
- **Server, modified:** `api.py` (token handling, CORS, `/connect-info`, bind address), `start.py` (launch hands off to Qivra launcher, no tunnels, no port-kill prompt).
- **Server, new:** `qivra/` package mounted on SuperBrain's FastAPI `app`; mirrors `analyses` rows into Qivra items (`sb_<shortcode>`) and `audio_transcription` into transcripts, without modifying SuperBrain tables.
- **App:** link-detection rules from `link_checker.py`/`urlUtils.ts`; the expo-sqlite/expo-camera/document-picker stack and the `com.superbrain.mobile` application id. All SuperBrain screens and services were replaced; the old ones are in commit `cbc1f42`.

## Data migration

- **Device:** on first launch `src/services/legacyImport.ts` reads SuperBrain's `superbrain_local.db` (`posts`) or the `@superbrain_posts_cache` AsyncStorage key, plus `@superbrain_collections`, and imports them once into `qivra.db` (`importLegacy`, tested). Old files are left untouched. Summaries are labelled "From your server" (they came from SuperBrain's AI pipeline).
- **Server:** `QivraStore.mirror_legacy_analyses()` copies `analyses` rows into `qv_entities` idempotently at startup; refreshes them only if no device edited the item since.
- **Rollback:** Qivra tables are additive (`qv_*` on the server, a separate `qivra.db` on the device). Deleting them returns SuperBrain to its prior state. Back up `server/superbrain.db` before upgrading.

## Licensing review

- SuperBrain is **AGPL-3.0** (`LICENSE`). Qivra modifies and extends it, so Qivra is a derivative work and must be distributed under AGPL-3.0. Because the server is network software, AGPL §13 applies: anyone interacting with a modified server over a network must be offered its source. Copyright and license notices were kept; the About screen credits SuperBrain.
- `superbrain-cli` is MIT (not included).
- New dependencies (all permissive): expo-secure-store, expo-background-task, expo-task-manager, expo-crypto, expo-clipboard, expo-localization, expo-system-ui, @react-navigation/bottom-tabs (MIT); jest, jest-expo, @testing-library/react-native (MIT, dev only); segno (BSD), pytest (MIT), Pillow (MIT-CMU, dev script only). Removed: react-native-web, react-dom, @expo/ngrok, axios, expo-linear-gradient, expo-haptics.
- Full transitive inventory: `npm ls --all` / `package-lock.json` and `server/.venv/bin/pip freeze`; no SBOM file is generated yet.
