# Test results

## 1.3.0 (2026-10-21) — AI through the paired server

- Release APK: `dist/Qivra-1.3.0-release.apk` (68 MiB), package `com.qivra.app`, version code 6, debug-signed. Verified: no provider key in the APK or JS bundle.
- TypeScript and Biome lint passed; Jest 172 passed, 4 live tests skipped; server pytest 76 passed, 4 live skipped (new: gateway auth, key never returned or logged, model forcing, field allow-list, error mapping, embeddings, env-file loading, https enforcement).
- Live check (in-process server, real Groq key from `server/qivra.env`): paired device → `/api/v1/ai/chat/completions` → `openai/gpt-oss-120b` answered with a correct `[S1]` citation; the key did not appear in any response.
- Groq preset model verified against Groq's live `/models` list; the Mistral, Gemini and OpenRouter preset model ids were not verified live (no keys).
- Not verified on the phone yet: requires restarting the server so it loads `qivra.env`, then installing 1.3.0.

## 1.2.0 (2026-10-21) — voice notes and dictation

- Release APK: `dist/Qivra-1.2.0-release.apk` (67.8 MiB), package `com.qivra.app`, version code 5.
- Android release build passed for arm64-v8a and x86_64. Signature, version, microphone permission, and bundled Whisper native libraries verified.
- TypeScript and Biome lint passed; 169 app tests passed, with 4 existing live tests skipped.
- Includes on-device Whisper/Parakeet voice notes, dictation in Notes/Search/Agent, and the accompanying server transcription integration. Server setup is documented in `docs/VOICE_AND_TRANSCRIPTION.md`.
- Uses the existing development signing configuration. Phone microphone capture and on-device inference still require hardware validation.

## 1.1.0 (2026-10-21) — `com.qivra.app`, automatic transcripts, video pages

| Check | Result |
|---|---|
| `tsc`, Biome | pass, 0 findings |
| Jest | 152 passed, 4 skipped (opt-in live tests; run with `QIVRA_LIVE=1`, all 4 passed: YouTube captions, Shorts, X oEmbed, article extraction) |
| Server pytest | 58 passed, 4 skipped (opt-in live; with `QIVRA_LIVE=1`: X video transcribed by faster-whisper, music-only reel → `NO_SPEECH`, silent reel → `NO_AUDIO`, YouTube via server → `BOT_CHECK` because YouTube bot-checks yt-dlp from this IP — the phone fetches YouTube captions directly instead) |
| Release build | `dist/Qivra-1.1.0-release.apk`, package `com.qivra.app`, versionCode 4; installs next to `com.superbrain.mobile` (verified on emulator) |

Emulator (API 35) with the release APK and a real server (`python -m qivra serve`, emulator → `http://10.0.2.2:5055`):

- Pairing by manual entry → Connected.
- YouTube share → opens its own page; captions fetched on the phone (timestamped), extracted summary with highlighted keywords, progress Saved → Transcript → Summary → Ready.
- X video share → "Transcribing on your Qivra server…" → server Whisper transcript ("Jose, team cap, welcome to the team!") merged into the page; thumbnail from server. Found and fixed: the app did not re-poll a waiting server job (now self-schedules).
- Instagram reels → music-only and silent reels finish honestly ("No speech to transcribe") with thumbnail/caption from the server. Found and fixed: server post details were lost on no-speech, and server-side patches surfaced as sync conflicts (now merged/rebased; integration test added).
- Wikipedia pages → article text, extractive summary, 12 keyword highlights with sentence moments. Found and fixed: default HTTP User-Agent was blocked by Wikipedia; references/TOC leaked into the summary.
- Library sections Videos · Websites · Notes with counts; Recent videos on Today.

Not verified: an Instagram reel **with speech** (no such public test reel available here; the same pipeline transcribed the X video), a physical iQOO 13 install, camera QR scanning.


Recorded 2026-10-21 on macOS (arm64), Node 26.10, JDK 21, Python 3.13, Android SDK 36, branch `feature/qivra-react-native-android`.

## Baseline (unmodified SuperBrain, commit cbc1f42)

| Check | Result |
|---|---|
| `tsc --noEmit` | pass (0 errors) |
| Biome | **failed to run** — invalid config (`indentStyle: "spaces"`); ESLint config present but ESLint not installed |
| Server `pytest tests` | 6 passed |
| `gradlew assembleDebug` (arm64, NDK 28.2 override) | BUILD SUCCESSFUL |

## Final

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | pass |
| Lint | `npx biome lint src App.tsx index.ts __tests__ plugins` | 0 findings (config fixed; style rules documented in `biome.json`) |
| Jest — logic & DB | `npx jest --selectProjects logic` | 126 passed (URL/share normalisation, transcripts, language, state machine, enrichment, search, timezones incl. DST, QR validation, reports, agent grounding & prompt-injection containment, provider adapter, API client, migrations, FTS, job queue persistence/recovery, legacy import, concurrency) |
| Jest — integration | (part of logic) `__tests__/db/sync.integration.test.ts` | passed: spawns the real Python server; QR parse → health → pairing; two devices push/pull, conflict, keep-both, keep-local, delete tombstones, revocation, server restart, pairing error mapping, wrong port |
| Jest — UI | `npx jest --selectProjects ui` | 9 passed (onboarding, library empty/list/filter, connect-screen validation without network, item detail transcript/provenance/destructive flag, agent citation navigation, report preview, capture, dark theme, font scaling) |
| Server | `server/.venv/bin/python -m pytest -q tests` | 48 passed (6 SuperBrain + 42 Qivra: pairing, replay, expiry, malformed, rate limits, global brute-force budget, revocation, multi-device, restart persistence, Host/Origin rejection, localhost-only mode, payload limits, no secrets in logs, items/optimistic concurrency, sync conflicts, transcripts, uploads/path traversal, jobs idempotency/recovery/cancel, SSRF guard, agent citations & injection, report timezones, legacy mirror, legacy token scoping) |
| Release build | `./gradlew assembleRelease` | BUILD SUCCESSFUL; `dist/Qivra-1.0.0-release.apk` (61 MB, arm64-v8a + x86_64, minSdk 24, target 36, debug-signed), SHA-256 in `dist/*.sha256` |

## Manual end-to-end (real processes)

**Server on this machine** (`python -m qivra serve --lan`): printed `http://127.0.0.1:5001` (5000 occupied by macOS ControlCenter) and LAN `http://10.109.230.239:5001` after health checks; curl over the LAN address: health → owner-only challenge refused from LAN → pairing → replay rejected → authenticated status → sync → forged Host rejected (421) → CLI pair/devices/revoke → revoked credential rejected.

**Release APK on an Android 15 (API 35, arm64) emulator, `qivra_test` AVD:**

| Flow | Result |
|---|---|
| Install & cold start | launched, no FATAL in logcat; onboarding rendered |
| Share sheet (`ACTION_SEND text/plain` to `ShareActivity`) | item saved, `?si=` tracking removed, receipt with real status |
| Pipeline | YouTube oEmbed title/channel/thumbnail fetched; language detected; status `NEEDS_INPUT` (no transcript) shown honestly; GitHub API description + README used |
| Duplicate share | "Already in your library" — one item (a double-ingestion race found here was fixed and covered by a test) |
| Dark mode | applied across screens |
| Pairing with the real laptop server over LAN (manual entry) | server identity confirmed, HTTP warning shown, paired, "Connected", device listed on server; shared items synced to the server |
| AI Agent without a model | "Compare the GitHub projects I saved" → retrieval-only answer citing both repos [S1][S2]; Markdown rendered |

## Not verified (needs hardware or credentials)

- Physical phone install, camera **QR scanning** (emulator has no real camera; QR parsing is unit-tested and manual pairing was tested on-device).
- Sharing **files** (SRT/VTT/audio/video) through the share sheet on a device (Kotlin copy path is not exercised by adb text shares; parsing/normalisation are unit-tested).
- Storage Access Framework **export** on a device, notifications/reminders, WorkManager background runs, TalkBack walkthrough.
- Hosted/local **AI providers** (no Ollama running, no API keys): model answers, model enrichment, embeddings, server enrichment/transcription/captions (these fail honestly with `NO_PROVIDER` / `TRANSCRIBER_UNAVAILABLE` / `CAPTIONS_UNAVAILABLE`, which is tested).
- Upgrade-in-place over a real SuperBrain install (import logic is tested; signing keys likely differ).
- Detox / instrumentation tests: not added; UI behaviour is covered by RNTL tests plus the scripted emulator run above.
- Expo Go: not supported (the phone's Expo Go is SDK 57; the project is SDK 54 and needs native code).
