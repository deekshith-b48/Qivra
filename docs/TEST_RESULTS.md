# Test results

## 1.8.0 (2026-10-22): UI theme revamp

- Release APK: `dist/Qivra-1.8.0-release.apk`, version code 12. New native module: `expo-linear-gradient`. New font: Plus Jakarta Sans.
- `tsc` and Biome pass. Jest: 266 passed, 4 live tests skipped. New tests:
  - WCAG contrast for every token pairing in both palettes
  - `FloatingTabBar` roles, labels, active pill, navigation and the separate "+"
- Emulator screenshots (release APK):
  - **Light:** Home (stat strip, image cards, round header buttons), Library (black segmented control), Settings (grouped cards).
  - **Dark:** Home, Library, Ask, Study and the item page (crimson glow, Rich Black cards, Soft White active pill, crimson "+").
- Found and fixed while testing:
  - Background gradients did not repaint when the theme changed in place (dark gradient behind light content). Gradients are now keyed by scheme and always use three stops.
  - GitHub README summaries showed `&middot;`-style entities; they are now decoded. GitHub repositories now get GitHub's preview image as their thumbnail.

## 1.7.1 (2026-10-22): conversational Ask and layout

- Release APK: `dist/Qivra-1.7.1-release.apk`, version code 11. Jest: 254 passed, 4 live tests skipped. Server pytest: 96 passed.
- Emulator (release APK, throwaway server with the Groq gateway):
  - "Heyy" in Library mode got a friendly greeting labelled as a general answer, where 1.7.0 said "I couldn't find anything…".
  - "Explain quantum tunnelling simply" in Library mode: the answer cited nothing, so "Answer generally" appeared. Pressing it switched to General, which streamed a full Markdown answer with headings, an analogy and bullets.
  - The composer sits clear of the tab bar, and the "+" button no longer overlaps it.
- The "no citations" warning no longer refers to "sources listed below" when there are none.

## 1.7.0 (2026-10-22): modern Ask, smart collections, report upgrades, flashcards

- Release APK: `dist/Qivra-1.7.0-release.apk`, version code 10, debug-signed. New native module: `expo-print`.
- `tsc` and Biome pass. Jest: 249 passed, 4 live tests skipped. Server pytest: 96 passed, 6 live skipped. The live Groq stream test passes with `QIVRA_LIVE=1`.
- Emulator (API 35, release APK, throwaway server with the Groq gateway):
  - "Compare the GitHub projects I saved" streamed in with the Stop button showing. The comparison table rendered as a grid while still streaming. The finished answer had citation pills, Copy, Regenerate and Sources (2).
  - Two GitHub links were shared in the background and got "Ready" notifications.
  - "Make flashcards" on a Wikipedia item made 3 AI cards. Reviewing them (show answer, then Good ×3) ended with "Done for today".
  - A smart collection "Dev tools" (source = GitHub) showed "2 matching items" while being built and appeared with its ✨ badge.
  - A collection report was generated, and PDF export produced the file and opened the Android share sheet.
- Found and fixed while testing on the emulator:
  - **Empty AI output:** gpt-oss is a reasoning model, and at the default effort a 900-token budget ran out before any output (`finish_reason=length`), so flashcard JSON was empty. The server now sends `reasoning_effort: low` for gpt-oss models (override with `QIVRA_AI_REASONING_EFFORT`), and the app allows 2,500 output tokens.
  - **Stop ignored:** a Stop pressed before the request began didn't stop it. The signal is now checked up front.
  - **Smart collections in "Add to collection":** they were offered as targets; they are now hidden there.
- Not verified: the weekly report notification on a real Monday (scheduling logic is unit-tested), smart-collection suggestions (this small test library had no topic shared by 3 items; unit-tested), and the iQOO 13 itself.

## 1.6.0 (2026-10-22): Library grid and swipe actions

- Release APK: `dist/Qivra-1.6.0-release.apk`, version code 9, debug-signed.
- `tsc` and Biome pass. Jest: 204 passed, 4 live tests skipped. New UI tests cover:
  - the grid tiles and list cards with their accessibility actions
  - archive followed by Undo
  - delete being hidden but not written, Undo restoring it, and leaving the screen committing it
  - adding a single item to a collection
- Emulator (API 35, release APK):
  - The Videos grid showed 2 columns with platform badges.
  - After switching to list, a swipe right archived a video and showed the Undo bar.
  - A swipe left showed the Collection and Delete buttons.
  - Delete followed by Undo after 1 s and after 6 s restored the item, and it was still there after the bar timed out.
  - The list/grid choice persisted across an app restart.
- Changed after testing: the Undo window went from 5 s to 8 s, because a 5 s window proved easy to miss.

## 1.5.0 (2026-10-22): navigation, Home feed, Ask about this, in-app player

- Release APK: `dist/Qivra-1.5.0-release.apk`, version code 8, debug-signed.
- `tsc` and Biome pass. Jest: 200 passed, 4 live tests skipped, including new tests for item Q&A citation checks, the Home feed query, merged Library search, scoped Ask, the in-page player seeking to a key moment, the "+" capture sheet and the digest text. Server pytest: 89 passed, 5 live skipped.
- Emulator (API 35, release APK, throwaway server with the Groq gateway):
  - Home showed the greeting, Ready to review cards with their one-line summaries, the digest card, and the Home · Library · + · Ask tab bar.
  - Library search for "elephants" returned matching passages from Wikipedia and from video transcripts.
  - Tapping the 0:07 key moment played the YouTube video inside the item page; it ran to the end without leaving the app.
  - "Ask about this" on the zoo video gave a Groq answer with five citations, each a real moment (0:01–0:16). Tapping a citation opened the item with the player loaded at that moment.
- Found while testing: installing a package with `--legacy-peer-deps` pruned `expo-font`, which is now a direct dependency. The emulator could not reach the host at 10.0.2.2 during this run, so pairing went through `adb reverse` and 127.0.0.1.
- Not verified: the 9 am digest firing (it is scheduled through the normal notification API; its text is unit-tested), and the iQOO 13 itself.

## 1.4.0 (2026-10-22) — background sharing, Groq Whisper, key moments

- Release APK: `dist/Qivra-1.4.0-release.apk` (68 MiB), `com.qivra.app`, version code 7, debug-signed; no provider key in the APK or JS bundle.
- `tsc` and Biome pass; Jest 191 passed, 4 live skipped; server pytest 89 passed, 5 live skipped. Live Groq tests run once with `QIVRA_LIVE=1` (generated speech; X video).
- Emulator (API 35, release APK, throwaway server on port 5055 with the Groq gateway), sharing from the home screen with the app force-stopped:
  - YouTube ("Me at the zoo"): home screen stayed in front; "Ready" notification with an AI one-line summary after 14 s.
  - Website (Wikipedia "Hummingbird"): "Ready" after 23 s; tapping it opened the item page with TL;DR, "AI-generated" label and key moments; the "Preparing…" notification and the service stopped.
  - X video: "Ready … Jose is welcomed to Team Cap." after 72 s. Groq rejected X's fragmented-MP4 audio, so the local engine answered; fixed by re-encoding to 16 kHz mono FLAC (test added) — the same post then transcribed through Groq in 2.9 s on the server path (not re-run on the emulator).
  - First share asked for notification permission once.
- Found and fixed on the emulator: plain background services are frozen within ~10 s (now a short foreground service); RN's task-finished callback never reached the service (now a result file); expo-notifications taps were lost after a headless start (now native notifications with `qivra://item/<id>`); Wikipedia `data-mw` attributes leaked wiki markup into text (attributes are stripped; test added).
- Not verified: the iQOO 13 itself, Instagram reels with speech, Android < 13 permission path.

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
