<div align="center">

<img src="assets/icon.png" width="88" alt="Qivra logo" />

# Qivra

**Turn what you save into what you know.**

A private, local-first knowledge vault for Android. Share a reel, video, web page or note, and Qivra transcribes it, summarises it and makes it searchable and askable, on your phone.

[![Latest release](https://img.shields.io/github/v/release/deekshith-b48/Qivra?label=release&color=E50914)](https://github.com/deekshith-b48/Qivra/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Android 7+](https://img.shields.io/badge/Android-7.0%2B-3DDC84?logo=android&logoColor=white)](https://github.com/deekshith-b48/Qivra/releases/latest)
[![Expo SDK 54](https://img.shields.io/badge/Expo-SDK%2054-000020?logo=expo&logoColor=white)](https://docs.expo.dev/)
[![Build](https://github.com/deekshith-b48/Qivra/actions/workflows/build.yml/badge.svg)](https://github.com/deekshith-b48/Qivra/actions/workflows/build.yml)

[Download](https://github.com/deekshith-b48/Qivra/releases/latest) · [Features](#features) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Development](#development) · [Contributing](#contributing)

</div>

<p align="center">
  <img src="docs/screenshots/home.jpg" width="19%" alt="Home" />
  <img src="docs/screenshots/item.jpg" width="19%" alt="Item page with summary and key moments" />
  <img src="docs/screenshots/ask.jpg" width="19%" alt="Ask your library" />
  <img src="docs/screenshots/glance.jpg" width="19%" alt="Glance: review and weekly stats" />
  <img src="docs/screenshots/dev.jpg" width="19%" alt="Dev mode" />
</p>

## Watch the overview

<p align="center">
  <a href="https://github.com/deekshith-b48/Qivra/releases/download/v2.0.0/Qivra-2.0.0-overview.mp4">
    <img src="docs/screenshots/overview-poster.jpg" width="260" alt="Play the 60-second Qivra overview video" />
  </a>
  <br />
  <sub><b><a href="https://github.com/deekshith-b48/Qivra/releases/download/v2.0.0/Qivra-2.0.0-overview.mp4">▶ Play the 60-second overview</a></b> · 1080×1920 MP4 with voiceover and captions</sub>
</p>

## Why Qivra

Saved posts pile up and are never seen again. Qivra keeps them **useful**: every link becomes a transcript, a one-line summary, timestamped key moments and highlighted keywords, all stored in a SQLite database **on your phone**. You can search it offline and ask questions that are answered from your own library, with citations.

- **No laptop needed:** install the app, add your free Groq key, and every feature works on the phone. An optional server adds live sync between devices.
- **Local-first:** your library lives on the device. No account, no cloud database.
- **Bring your own AI key:** each user adds their own free Groq key during setup. No key ships in the app.
- **Works without AI:** search, transcripts, extractive summaries and flashcards still work with no key at all.

## Features

| | |
|---|---|
| **Capture** | Share from Instagram, X, YouTube, a browser or any app and keep scrolling. Paste a link, write a note, record a voice note, or import files, screenshots and transcripts (SRT, VTT, TXT). Shares survive the app being killed. |
| **Understand** | YouTube captions are fetched on the phone. X and Instagram videos, imported audio/video files and voice notes of up to 12 minutes are transcribed by Groq Whisper with your own key, straight from the phone (Instagram when the post's public embed shares the video; otherwise its caption is used). On-screen text in silent reels and text in images are read on the phone. GitHub links keep their README as Markdown. Each item gets a TL;DR, key moments linked to timestamps, and keyword highlights. |
| **Ask & learn** | Chat with your whole library or one item. Answers stream, cite numbered sources and jump to the right second of a video. Make flashcards from any item and review them with spaced repetition. Daily, weekly and topic reports export as Markdown or PDF. |
| **Organise** | Library grid or list, full-text search (SQLite FTS5) and search by meaning (your Groq key rewrites the query into synonyms and translations; add an optional free Gemini key for true vector search and Related items), smart collections, favourites, highlights and revisit reminders. Swipe to archive or delete, with undo. |
| **Dev mode** (opt-in) | A Dev tab with AI trends from GitHub, Hacker News and Hugging Face; Claude Code skills, plugins and MCP servers (top or new this week); follow-ups on topics you choose, with new releases of repos you follow; a daily-habit streak with a 5-week heatmap and a weekly recap; and a searchable toolbox of the repos, tools and commands in your library, grouped by tool. Hidden unless you turn it on. |
| **Privacy** | Keys in Android's Keystore, no backups to the cloud, permissions asked only when needed, and saved content treated as untrusted (commands are shown, never run). |

<details>
<summary>More screenshots</summary>
<p align="center">
  <img src="docs/screenshots/library.jpg" width="24%" alt="Library" />
  <img src="docs/screenshots/home_dark.jpg" width="24%" alt="Home, dark theme" />
  <img src="docs/screenshots/settings_dark.jpg" width="24%" alt="Settings, dark theme" />
</p>
</details>

## Quick start

### 1. Install the app

Download **`Qivra-2.1.0-release.apk`** from the [latest release](https://github.com/deekshith-b48/Qivra/releases/latest) and open it on your phone (Android 7.0 or newer). Allow your file manager to install unknown apps when Android asks.

> The APK is signed with the Android debug key and is meant for sideloading. Check the download against the `.sha256` file attached to the release.

### 2. Add your own Groq key

The setup screens ask for an AI key. Groq's tier is free and fast:

1. Tap **Get a free Groq key**, sign in at [console.groq.com/keys](https://console.groq.com/keys) and create a key.
2. Paste it into **Your Groq API key** and tap **Verify & save**.

Qivra sends a tiny test request, then stores the key in Android's secure storage. It is sent only to Groq, and only when you ask, summarise or save a video (the video's audio is sent for its transcript). Tap **Later** to skip; you can add it any time under **Settings → AI models**.

That's it: no laptop or server is needed. Optional: for true search by meaning, add a free [Gemini key](https://aistudio.google.com/apikey) under **Settings → AI models → Search by meaning**.

### 3. Run your own server (optional)

Not needed for any feature. The server, on your laptop, adds live sync between devices and lets you keep audio on your own computer (local Whisper).

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements-qivra.txt -r requirements-media.txt
cp qivra.env.example qivra.env      # add your Groq key here for server-side AI and Whisper
.venv/bin/python -m qivra serve --lan
```

The server prints a QR code. In Qivra, open **Settings → Your Qivra server → Scan QR code**. Optional extras:

```bash
.venv/bin/pip install -r requirements-embeddings.txt -r requirements-ocr.txt   # search by meaning, text in reels
.venv/bin/pip install -r requirements-transcribe-anything.txt                  # MLX Whisper on Apple Silicon
```

## How it works

```mermaid
flowchart LR
  subgraph Phone["Android phone · Qivra app"]
    Share["Share sheet"] --> Jobs["Durable job queue"]
    UI["Home · Glance · Library · Ask · Dev"] --> Jobs
    Jobs --> DB[("SQLite + FTS5<br/>items · transcripts · chunks")]
    Jobs --> Whisper["On-device Whisper<br/>voice notes"]
    Key[("Keystore<br/>device credential · AI key")]
  end

  subgraph Laptop["Your laptop · Qivra server (optional)"]
    API["FastAPI /api/v1<br/>pairing · sync · jobs · search"]
    Media["yt-dlp · Whisper · OCR · embeddings"]
    GW["AI gateway<br/>key in qivra.env"]
    API --> Media
    API --> GW
  end

  Jobs <-->|"LAN or VPN · per-device token"| API
  Jobs -->|"captions · page text"| Web(("YouTube · X · web"))
  Jobs -->|"your own key"| Groq(("Groq API"))
  GW --> Groq
  Media -->|"opt-in"| Groq
```

1. **Capture.** A share writes an envelope to disk, starts a foreground service and returns you to the app you were in.
2. **Process.** Each step (metadata, transcript, summary, index) is a row in a durable `jobs` table. Steps retry with backoff, recover after a crash and wait for the server when the laptop sleeps.
3. **Enrich.** The model gets the transcript with `[mm:ss]` markers. Timestamps are snapped to real segments, and keywords that are not in the source are dropped.
4. **Use.** Search, Ask, flashcards and reports read the local database. Ask answers only from your saved items and cites them.

Read more in [Architecture](docs/ARCHITECTURE.md), [AI providers and transcripts](docs/AI_PROVIDERS_AND_TRANSCRIPTS.md), [Local server and QR pairing](docs/LOCAL_SERVER_AND_QR_PAIRING.md) and [Voice and transcription](docs/VOICE_AND_TRANSCRIPTION.md).

## Configuration

Server settings live in `server/qivra.env` (git-ignored). Copy it from [`qivra.env.example`](server/qivra.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `QIVRA_AI_BASE_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-compatible provider (HTTPS only for hosted ones). |
| `QIVRA_AI_API_KEY` | *(empty)* | Your provider key. Stays on the laptop; paired phones use it through the gateway. |
| `QIVRA_AI_MODEL` | `openai/gpt-oss-120b` | Chat model for summaries and Ask. |
| `QIVRA_AI_EMBEDDING_MODEL` | *(empty)* | Optional hosted embedding model. |
| `QIVRA_TRANSCRIBER` | `auto` | `groq` sends audio to Groq Whisper; `auto` keeps audio on the laptop. |
| `QIVRA_AI_REASONING_EFFORT` | `low` | `low`, `medium` or `high` for reasoning models. |

| Flag | Purpose |
|---|---|
| `--lan` | Listen on your Wi-Fi so phones can pair. |
| `--remote` | Like `--lan`, but the QR prefers your Tailscale / WireGuard address, for use away from home. Nothing is exposed to the internet. |
| `--no-qr` | Do not print the pairing QR code. |

## Privacy & security

- **Your key, your account.** The app ships no API key. Each user's key is stored in Android's Keystore and is never logged, synced, exported or put in a QR code.
- **Pairing:** one-time codes that expire after 5 minutes, rate-limited, and a separate revocable token per device, stored only as a SHA-256 hash on the server.
- **Server hardening:** admin routes answer only on loopback; Host and Origin checks against DNS rebinding; SSRF guards on server fetches; size limits; no API docs served; security headers.
- **Network:** cleartext HTTP only to private, LAN or VPN addresses.
- **Content:** saved text is untrusted data. It cannot instruct the AI, and commands in it are never executed.

Full details: [Security and privacy](docs/SECURITY_AND_PRIVACY.md). To report a vulnerability, please open a private [security advisory](https://github.com/deekshith-b48/Qivra/security/advisories/new) rather than a public issue.

## Development

**Requirements:** Node.js 20+, JDK 17–21, Android SDK 36 with NDK 28, Python 3.11+. Expo Go is not supported (the app has native code).

```bash
npm ci
npx tsc --noEmit                                   # type check
npx jest                                           # app tests (logic + UI)
cd server && .venv/bin/python -m pytest -q tests   # server tests
```

**Build the release APK:**

```bash
QIVRA_ANDROID_ABIS=arm64-v8a,x86_64 npx expo prebuild --platform android --clean --no-install
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleRelease
```

The APK is written to `android/app/build/outputs/apk/release/app-release.apk`. An emulator reaches a server on the same machine at `http://10.0.2.2:<port>`.

### Project structure

```
├── App.tsx                 navigation, deep links, notification taps
├── src/
│   ├── core/               pure TypeScript: URLs, metadata, captions, highlights, search, reports
│   ├── db/                 SQLite schema, migrations and repository
│   ├── services/           side effects: capture, jobs, share task, AI, voice, reminders
│   ├── sync/               revision-based sync and conflicts
│   ├── screens/            Home, Glance, Library, Ask, Dev, item page, settings
│   └── ui/                 design tokens, theme and shared components
├── plugins/                Expo config plugin + native Kotlin share target and service
├── server/
│   ├── qivra/              FastAPI server: pairing, sync, jobs, media, AI gateway
│   └── tests/              pytest suite
├── __tests__/              Jest suites (core, db, ui)
└── docs/                   architecture, security, test results
```

`src/core` has no React Native imports, so it is tested directly. Native code is limited to two Kotlin files in `plugins/android`.

## Roadmap

- [ ] Signed release builds and an F-Droid listing
- [ ] iOS share extension
- [ ] Encrypted export and restore
- [ ] On-device embeddings, so search by meaning works without a server

Ideas and votes are welcome in [Issues](https://github.com/deekshith-b48/Qivra/issues).

## Contributing

Contributions are welcome.

1. Open an issue first for larger changes, so we can agree on the approach.
2. Fork, create a branch, and keep the change focused.
3. Add a test for any new logic or bug fix, and run `npx tsc --noEmit`, `npx jest` and the server tests.
4. Open a pull request that explains what changed and why, with screenshots for UI changes.

Match the existing style: small functions, shared components from `src/ui`, and no secrets in code or commits.

## License

Qivra is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version for others, you must share its source.

## Acknowledgements

Qivra began as a fork of [SuperBrain](https://github.com/sidinsearch/superbrain) by sidinsearch, also under the AGPL-3.0. Copyright notices and the list of changes are in [NOTICE.md](NOTICE.md). Thanks to the authors of React Native, Expo, whisper.cpp, Groq, FastAPI and the other open-source projects Qivra builds on.
