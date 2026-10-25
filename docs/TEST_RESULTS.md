# Test results

## 2.2.3 (2026-10-25): Instagram reel attach, English transcripts, new reports

- Release APK: `dist/Qivra-2.2.3-release.apk`, version code 22.
- `tsc` passes. Jest: 328 passed, 4 live tests skipped.
- Instagram: "Add the downloaded reel" on an Instagram item attaches the reel downloaded in Instagram and transcribes it into the same item. Checked on the emulator: the picker opened, the picked video reached Groq (a fake key was rejected as expected).
- English by default: non-English transcripts are translated with the user's Groq key line by line (timestamps kept, resumes after rate limits or lost connection), shown first and used for summaries. Tests: batch parsing, a Hindi video translated and summarised in English. Not run with a real key.
- Reports: new template (summary, key takeaways, topics with titles, by source with timestamps, short footer), new PDF template, and new generate and report screens (type grid, header stats, Share PDF + More). Checked on the emulator.

## 2.2.2 (2026-10-25): verified on a device; clear YouTube and Instagram limits

- Release APK: `dist/Qivra-2.2.2-release.apk`, version code 21.

- `tsc` passes. Jest: 322 passed, 4 live tests skipped.
- Checked on the emulator (release build): YouTube captions work on Android (a new video got its 6-line transcript with no key). The phone transcription path works end to end: an X video was downloaded and uploaded to Groq, which rejected the fake test key as expected.
- Checked from the Mac: Instagram's public embed page for real reels (found through public Hacker News links) is an empty JavaScript shell; the reel is loaded only through Instagram's private API, which Qivra does not use. So reel links now explain the working route: download the reel in Instagram and share the saved video, which is transcribed like any video file.
- Checked from the Mac: YouTube's audio streams can't be downloaded by apps any more (after the first few KB they redirect or return 403 without a token only YouTube's own apps produce), and the app does not try to get around that. A YouTube video without captions now says so and offers importing a transcript. Captions are still fetched as before (tested on saved real YouTube responses, with IPs and signatures removed).
- Fixed: a key Groq rejects now asks for a new key (it used to finish as "No speech"), so saving a working key re-runs the item.
- 2.2.1 (built, not released) is included.

## 2.2.1 (2026-10-25): fixes from a code review

- Release APK: `dist/Qivra-2.2.1-release.apk`, version code 20.
- `tsc` passes. Jest: 320 passed, 4 live tests skipped.
- Fixed: an unreadable reply (for example an HTML error page from X) no longer waits for the internet forever; it uses up an attempt and ends with a message. Test included (fails on 2.2.0).
- Fixed: videos shared before the Groq key was added are transcribed as soon as the key is saved (also after a rejected key is replaced). Test included.
- Removed dead sync helpers and the unused server voice setting.

## 2.2.0 (2026-10-24): no server — the whole app runs on the phone

- Release APK: `dist/Qivra-2.2.0-release.apk`, version code 19.

- `tsc` passes. Jest: 318 passed, 4 live tests skipped.
- Removed from the app: server pairing, QR scanning, sync and conflicts, the server AI gateway, server transcription and server voice notes (with their tests).
- New tests:
  - A phone that was paired with the old laptop server forgets the pairing once (token and connection cleared, server jobs dropped) and a video stuck "Transcribing on your Qivra server" is re-run and transcribed through Groq on the phone.
  - Offline: a shared X video waits for the internet without using up attempts ("Waiting for internet…"), also across several app re-opens, and finishes by itself once the network is back.
  - Onboarding has no server step; Settings and Home have no server UI.
- Two UI tests that relied on render timing now wait for their data (Favourites shelf, the transcript line count).

## 2.1.0 (2026-10-24): every feature works without a server

- Release APK: `dist/Qivra-2.1.0-release.apk`, version code 18.

- `tsc` passes. Jest: 363 passed, 4 live tests skipped. Server pytest unchanged (131 passed).
- New tests:
  - X: syndication token and URL, smallest MP4 on X's CDN picked from a real response (saved as a fixture); other hosts refused.
  - Instagram public embed: video and caption parsed (also JSON escaped twice); other hosts refused; a blocked page gives nothing, without crashing.
  - Groq Whisper `verbose_json`: timed segments, language names to codes, music and filler mean "no speech".
  - Real pipeline with no server paired: an X video is transcribed through Groq with the user's key (Bearer header, the download is deleted); an Instagram reel that won't share its video finishes with its caption and sends nothing to Groq; an imported audio file is transcribed (the user's file is kept); with no key, the item asks for a Groq key instead of a server.
  - Search by meaning without embeddings: an English query finds a Hindi reel through the rewritten query, and the rewrite is cached; expansion replies are parsed safely.
  - Optional Gemini key: verified with a test embedding and stored on success; a rejected key stores nothing.
- Live check (from the Mac): X's public syndication endpoint returned the post and its MP4 downloaded. Instagram could not be checked live (no public reel available to test with).
- Fixed a flaky Library test (the Favourites list now gets 5 s to reload).

## 2.1.0 (2026-10-24): Dev tab upgrades

- `tsc` passes. Jest: 353 passed, 4 live tests skipped. Server pytest: 131 passed.
- New tests:
  - Followed `owner/repo` terms: safe-name check, release URL, release parsing (drafts and non-GitHub links dropped, pre-releases flagged).
  - Claude corner "new this week" query; commands grouped by tool (`sudo`, `VAR=x`, `npx` and `python -m` handled); heatmap days across a month boundary and best streak.
  - Dev screen: a followed repo's release shows by tag; the heatmap counts active days; Weekly report opens the report; "New this week" asks GitHub for recent repos; a library repo is marked "In your library"; the Toolbox filter narrows the lists and commands appear under tool headings.
- Emulator (release build, live network):
  - Following `anthropics/claude-code` showed its latest releases (v2.1.310, v2.1.309, v2.1.308) with tag icons.
  - Heatmap, best streak and the "Last 7 days" card fit in light and dark themes.
  - Claude "New this week" listed only repos created in the last week; Top is unchanged.
  - Toolbox filter "whisper" narrowed to 3 repos and 1 tool.
- Not verified on the emulator: command groups and the "In your library" mark (this test library has no saved commands or matching repos; both are covered by the UI test).

## 2.0.0 (2026-10-23): bring-your-own Groq key, compact UI, open fixes

- Release APK: `dist/Qivra-2.0.0-release.apk`, version code 17.
- `tsc` passes. Jest: 348 passed, 4 live tests skipped. Server pytest: 131 passed.
- New tests (the upgrade test checked to fail on the old code):
  - Onboarding Groq page: a valid key is verified against Groq and stored; a rejected key shows an error and stores nothing.
  - A README upgrade whose GitHub fetch fails keeps the saved repo details.
  - Tapping a keyword on a Markdown README filters its paragraphs; autolinks survive Markdown cleaning.
  - A background share recovers jobs left running by a killed process.
  - About shows the AGPL notice, "no warranty" and a link to NOTICE.md.
- Emulator (release APK, fresh install, light and dark):
  - Onboarding reaches the Groq page; an invalid key is rejected by Groq with a clear message; "Later" skips.
  - Every main screen (Home, Glance, Library, Dev, item page, Ask, Settings) fits the screen with the smaller type and controls; no crashes.
  - The UI text of every screen was dumped and searched: no upstream project name remains.
  - Server banner: "QIVRA LOCAL SERVER v2.0.0".

## 1.9.3 (2026-10-22): colourful Home and Glance, compact item page, modern Ask

- Release APK: `dist/Qivra-1.9.3-release.apk`, version code 16.
- `tsc` passes. Jest: 321 passed, 4 live tests skipped. Server pytest unchanged (131 passed).
- New tests: Home feature tiles and quick-capture navigation; Glance due count and Start review; nav bar hidden during an Ask chat; item page tabs; README Markdown cleaning; URL-free and code-free keywords; tool keyword cap; text contrast on every colourful tile in both themes.
- Emulator (release APK, light and dark):
  - Home: greeting with Fluent 3D emoji, colourful stat tiles, quick capture, 12 feature tiles with counts and a server status dot; warnings near the top.
  - Glance: review card, this week's stats, colourful topics, latest report; `qivra://glance` and the old `qivra://study` open it.
  - Ask: the answer fills the screen, the composer sits right above the keyboard, the nav bar hides during a chat and Android back returns to the start screen.
  - Item page: compact header and Summary / Transcript (README) / Details tabs; YouTube timestamps play in place; GitHub READMEs render as Markdown, and an old plain-text README upgraded itself on start.
- Not verified on devices: a phone with a real review history (no streak yet), the conflict screen for a deleted item (needs two phones; covered by tests).

## 1.9.2 (2026-10-22): security hardening and code cleanup

- Release APK: `dist/Qivra-1.9.2-release.apk`, version code 15.
- `tsc` passes. Jest: 293 passed, 4 live tests skipped. Server pytest: 131 passed, 9 live skipped; live OCR and embedding tests pass on Pillow 13.0.0.
- New tests (each checked to fail on the old code):
  - API docs (`/docs`, `/redoc`, `/openapi.json`) are not served; responses carry `nosniff`.
  - Legacy `/reset/database` and `/reset/api-token` refuse a paired phone's token (403) and still work from the laptop.
  - Pairing, revocation and the brute-force lockout are logged without codes or tokens.
  - A render crash shows an error screen with Retry instead of closing the app.
- Live server check (LAN address): `/docs`, `/redoc`, `/openapi.json` → 404; unauthenticated `/reset/database` → 403.
- Dependencies: Pillow 11.3.0 → 13.0.0 (58 advisories). npm non-breaking audit fixes: 37 → 28 findings, critical removed; the rest are Expo/React Native build tools that need an SDK upgrade.
- Emulator: the release APK with the updated npm lockfile opens to the Home screen with no crash.

## 1.9.1 (2026-10-22): privacy and safety fixes from a code audit

- Release APK: `dist/Qivra-1.9.1-release.apk`, version code 14. No new dependencies.
- `tsc` passes. Jest: 293 passed, 4 live tests skipped. Server pytest: 128 passed, 9 live skipped. New tests:
  - Commands in server summaries keep the "potentially destructive" warning.
  - Deleting an item removes its transcripts and uploads on the server, its server search hits, and its text; older deletes are cleaned at startup.
  - Server transcript search treats `%` and `_` literally.
  - Items deleted on another device hand back their media files for removal; conflicts with a deleted item show as deletions, and "Keep both" keeps this phone's copy with its media.
  - Stored vectors are parsed once and re-read only after the library changes.
  - The new server and conflict tests were checked to fail on the old code.
- Emulator (release APK built just before the final "Keep both" fix, throwaway server):
  - A server item with `sudo rm -rf ~/` and `ls -la` shows "⚠ Potentially destructive" on the first command only.
  - Deleting "Elephant" on the phone, then syncing, left an empty tombstone on the server; its transcript, upload file and search hit were gone.
- Not verified on devices: the conflict screen for an item deleted on another device (needs two phones; covered by tests).

## 1.9.0 (2026-10-22): OCR, search by meaning, away-from-home access

- Release APK: `dist/Qivra-1.9.0-release.apk` (94 MB; ML Kit text models are bundled), version code 13.
- `tsc` and Biome pass. Jest: 288 passed, 4 live tests skipped. Server pytest: 125 passed, 9 live skipped. Live checks run with `QIVRA_LIVE=1` and pass: RapidOCR on an image and on a video, and multilingual embedding similarity (English ↔ Hindi 0.62, unrelated ≈ 0).
- Emulator (release APK, throwaway server with the Groq gateway and local embeddings):
  - An image with text, shared from Google Photos, stayed in Photos and gave the notification "Ready: ocr_test — Postgres tips Use a GIN indexX for JSONB queries." The text came from on-device OCR, with one ML Kit misread ("indexX").
  - Library search "turn speech into text": a keyword hit (OpenWhispr) plus "Related by meaning: zackees/transcribe-anything", which shares no words with the query.
  - The item page for transcribe-anything shows Related: OpenWhispr, matched by embeddings.
  - The connection screen shows the "Use Qivra away from home" guidance.
- Not verified on devices:
  - Tailscale (this Mac has no Tailscale; detection and failover are covered by mocked tests).
  - On-screen text in a real silent reel (a generated test video passes).
- Testing note: `adb am start` cannot lend a MediaStore image to another app, so the image was shared from the Photos app instead.

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
