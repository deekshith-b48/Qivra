# Test results

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
