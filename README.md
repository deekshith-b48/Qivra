# Qivra

**A private, local-first knowledge vault for Android.**

Save the useful things you find, keep them searchable on your device, and ask questions grounded in your own library. Qivra turns shared links, notes, articles, and transcripts into a personal knowledge base—with an optional server you control for sync and heavier processing.

[![Latest release](https://img.shields.io/github/v/release/deekshith-b48/Qivra?label=latest%20release)](https://github.com/deekshith-b48/Qivra/releases/latest)
[![Android](https://img.shields.io/badge/platform-Android-3DDC84?logo=android&logoColor=white)](https://github.com/deekshith-b48/Qivra)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

## Get Qivra

**[Download the latest Android APK](https://github.com/deekshith-b48/Qivra/releases/latest)** · [Browse all releases](https://github.com/deekshith-b48/Qivra/releases)

The latest local build is **1.4.0** (`com.qivra.app`, version code `7`): share from Instagram, X, YouTube or a browser and stay there — Qivra transcribes and summarises in the background and notifies you when it is ready. Open [Qivra-1.4.0-release.apk](dist/Qivra-1.4.0-release.apk) on your Android phone and allow your file manager to install unknown apps when Android prompts you. The GitHub links above point to published releases.

> **Sideloading note:** The APK is signed with the Android debug key, not a private production release key. It is suitable for personal testing and sideloading, but is not a Play Store release. Android treats Qivra as a separate app from SuperBrain; existing SuperBrain data can sync through your paired server.

## Your knowledge, ready when you are

| Save | Understand | Rediscover |
|---|---|---|
| Share links from Android, capture notes, and import transcripts or supported files. | Extract useful article text, summaries, key points, and timestamped transcript highlights. | Search your local library, browse videos, websites, and notes, and group saved items into collections. |
| Keep a durable record even when you are offline. | Ask questions and get answers tied to numbered sources from your own library. | Create daily or topic reports from the information you have saved. |

### Built for a personal library

- **Local-first storage:** Your library lives in a SQLite database on your device. Full-text search uses SQLite FTS5 and remains available without a server.
- **Useful without an AI model:** Qivra can extract summaries and key points locally and provide retrieval-based answers with citations. Optional OpenAI-compatible models add generated answers, enrichment, or semantic search.
- **Video pages, not just bookmarks:** Shared videos get their own detail page with summary, transcript, and highlights. YouTube captions are fetched on the phone when available; supported public video links can use your paired server for transcription.
- **Voice notes and dictation:** Record and transcribe on Android with downloadable Whisper or Parakeet models. Dictate notes, search queries, and Agent messages; optionally send voice notes to your paired server. See [Voice and transcription](docs/VOICE_AND_TRANSCRIPTION.md).
- **Keep your context:** Search and organize saved articles, transcripts, notes, and other captured items together.
- **Sync on your terms:** Pair with your own laptop server to sync devices and run heavier processing. The server is optional for core capture, local search, and library use.
- **Grounded answers:** Agent responses cite saved items and transcript passages. When no model is configured, Qivra uses retrieval instead of pretending a model answered.

For precise provider behavior, transcript sources, and limitations, see [AI providers and transcripts](docs/AI_PROVIDERS_AND_TRANSCRIPTS.md).

## How it works

```text
Share or capture
       │
       ▼
Your local Qivra library ──► extract, index, and organize
       │                              │
       │ optional server              ├──► offline search
       ▼                              ├──► cited answers
Sync and heavier processing           └──► reports
```

### Video and link processing

Qivra shows progress as an item is processed and preserves honest outcomes:

- **YouTube:** The app fetches captions published by YouTube when available. Captions are not invented when a video has none.
- **Supported public video links:** With a paired server, eligible links can be transcribed using locally run Whisper. Private or login-gated posts may not be available.
- **Articles and GitHub pages:** Readable page text is extracted and indexed for search.
- **Highlights:** Transcript moments keep their timestamps, so supported video highlights can open at the relevant point.

Processing details and source-specific behavior are documented in [AI providers and transcripts](docs/AI_PROVIDERS_AND_TRANSCRIPTS.md).

## Optional: connect your own server

The companion server is useful for syncing with a laptop, processing supported video audio, and using server-side AI providers. It runs on your own machine; Qivra does not require a hosted Qivra account.

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements-qivra.txt -r requirements-media.txt
.venv/bin/python -m qivra serve --lan
```

The server prints its working local and LAN addresses, a one-time pairing code, and a QR code. In Qivra, open **Settings → Connect to My Server → Scan QR code**. Use `--lan` only when you want another device on your network to connect; without it, the server listens on loopback only.

To give paired phones AI answers and summaries without entering anything on the phone, copy `server/qivra.env.example` to `server/qivra.env` and add your provider key (for example a Groq key). The key stays on your machine; phones use it through the server.

`requirements-media.txt` enables local Whisper transcription for supported public video links. The selected Whisper model downloads on first use. See [Local server and QR pairing](docs/LOCAL_SERVER_AND_QR_PAIRING.md) for network setup, pairing, TLS, and troubleshooting.

## Privacy by design

- Your library is stored in app-private storage on your device.
- Qivra has no ads, analytics, or crash-reporting service.
- An external AI endpoint is optional. Qivra asks for consent before sending saved content outside your network; API keys are stored in Android Keystore-backed secure storage.
- Server pairing uses a short-lived, one-time code and per-device credentials. The server listens on loopback by default; LAN access is opt-in.
- Microphone access is requested when you start a recording. Camera access is used for pairing QR scans, and notifications are optional. Files are selected through Android's document picker or shared into Qivra.

Read the full [security and privacy notes](docs/SECURITY_AND_PRIVACY.md) before exposing a server to a network.

## Development

### Requirements

- Node.js 20 or newer
- JDK 17–21 and Android SDK (platform 36, build-tools 36) for Android builds
- Python 3.11 or newer for the server

### Install and validate

```bash
npm ci
npx tsc --noEmit
npx biome lint src App.tsx index.ts __tests__ plugins
npx jest

cd server
.venv/bin/python -m pytest -q tests
```

The server test command assumes the server virtual environment and dependencies are installed. See the server setup above.

### Build a release APK

Set `JAVA_HOME` and `ANDROID_HOME` to your local JDK and Android SDK paths, then run:

```bash
QIVRA_ANDROID_ABIS=arm64-v8a,x86_64 npx expo prebuild --platform android --clean --no-install
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android
./gradlew assembleRelease
```

The APK is written to `android/app/build/outputs/apk/release/app-release.apk`. `QIVRA_NDK_VERSION` can pin the NDK when needed. Android project files are generated: make native configuration changes in [`plugins/withQivraAndroid.js`](plugins/withQivraAndroid.js), then regenerate the project.

For emulator testing, the emulator reaches a server on the development machine at `http://10.0.2.2:<port>`. For USB testing in loopback mode, use `adb reverse tcp:5001 tcp:5001`.

## Project map

| Path | Purpose |
|---|---|
| `App.tsx`, `src/screens/`, `src/ui/` | React Native app, navigation, screens, and shared interface components |
| `src/core/` | Platform-independent capture, enrichment, transcript, search, agent, report, and API logic |
| `src/db/`, `src/sync/` | SQLite schema and migrations, repository, and synchronization engine |
| `src/services/` | Device storage, capture, processing, pairing, and background task integrations |
| `plugins/` | Expo configuration and Android share-target integration |
| `server/qivra/` | Qivra server API, pairing, jobs, media, and knowledge features |
| `server/core/`, `server/analyzers/` | SuperBrain server components and analysis pipeline |
| `docs/` | Architecture, setup, privacy, provider behavior, migration, and test results |

For the layer boundaries and data flow, start with [the architecture guide](docs/ARCHITECTURE.md).

## Troubleshooting

- **"Not a Qivra server":** Use the exact address printed by the server. If port 5000 is occupied, Qivra may use port 5001.
- **The phone cannot reach the server:** Check that both devices are on the same Wi-Fi, that the server was started with `--lan`, and that the firewall permits Python connections. Guest Wi-Fi may isolate devices.
- **Pairing code expired or was already used:** Generate a new code from the server terminal and scan again.
- **A video has no transcript:** Captions may not be published, or the link may be private, login-gated, or unsupported. Pair a server for eligible transcription jobs; Qivra does not fabricate transcripts.
- **Expo Go does not work:** This app requires native Android integrations. Install a development or release APK instead.

## Lineage and license

Qivra is built on [SuperBrain](https://github.com/sidinsearch/superbrain), with the migration and licensing context documented in [SuperBrain to Qivra migration](docs/SUPERBRAIN_TO_QIVRA_MIGRATION.md). This project is licensed under **AGPL-3.0**; see [LICENSE](LICENSE).
