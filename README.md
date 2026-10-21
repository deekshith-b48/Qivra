# Qivra

A private, local-first knowledge vault for Android. Save links, notes, transcripts and media from any app, search everything offline, ask questions answered from your own library with citations, and generate daily or topic reports. Optionally pair with your own laptop server for sync and heavier processing.

Qivra is built on [SuperBrain](https://github.com/sidinsearch/superbrain) (AGPL-3.0) — see [docs/SUPERBRAIN_TO_QIVRA_MIGRATION.md](docs/SUPERBRAIN_TO_QIVRA_MIGRATION.md).

| Path | What |
|---|---|
| `App.tsx`, `src/` | React Native (Expo SDK 54, RN 0.81, TypeScript) Android app |
| `src/core/` | Pure logic: URLs, share payloads, transcripts, enrichment, search, dates, QR, agent, reports, API client |
| `src/db/`, `src/sync/` | SQLite schema/migrations, repository, sync engine |
| `src/services/`, `src/screens/`, `src/ui/` | Device services, screens, design system |
| `plugins/` | Expo config plugin + native `ShareActivity.kt` |
| `server/` | SuperBrain FastAPI backend + the Qivra `/api/v1` package (`server/qivra/`) |
| `docs/` | Architecture, pairing, AI/transcripts, security, test results |

## Install the APK

The release APK is `dist/Qivra-1.1.0-release.apk`. On the phone: open the file and allow "Install unknown apps" for your file manager when Android asks. Since 1.1.0 the package is **`com.qivra.app`**, so it installs alongside SuperBrain (1.0.0 used SuperBrain's id and could not replace a differently-signed SuperBrain install). SuperBrain data reaches Qivra through the server: pair once and the server's SuperBrain items sync down.

### What happens when you share a video or link

| Shared | Transcript | Summary & highlights |
|---|---|---|
| YouTube (incl. Shorts) | Captions YouTube publishes, fetched on the phone; otherwise your server | Extracted on the phone; keyword highlights with timestamps you can tap to play |
| Instagram reel / X video | Your paired server downloads the public audio (yt-dlp) and transcribes it with local Whisper | Same; caption text is used too |
| Music-only / silent / image posts | "No speech to transcribe" — never invented | From caption/post text |
| Websites, GitHub | Article text / README extracted on the phone | Same |

Each item opens on its own page with **Summary · Transcript (or Article) · Highlights** tabs and a live progress bar; the Library is split into **Videos · Websites · Notes**.

The APK in this repo is **signed with the Android debug key** (no release keystore exists yet). It is fine for personal sideloading, not for the Play Store.

## Run the local server (optional, needed for Instagram/X transcription)

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements-qivra.txt -r requirements-media.txt
.venv/bin/python -m qivra serve --lan
```

`requirements-media.txt` (yt-dlp + faster-whisper, free and local) enables automatic video transcription; the Whisper model (`QIVRA_WHISPER_MODEL`, default `base`, ~145 MB) downloads on first use. Only public posts work — no login cookies are used.

It prints the **real** local and LAN URLs (only after a health check), a one-time Access ID and a QR code. In the app: Settings → Connect to My Server → Scan QR code. Without `--lan` the server listens on 127.0.0.1 only. Details: [docs/LOCAL_SERVER_AND_QR_PAIRING.md](docs/LOCAL_SERVER_AND_QR_PAIRING.md).

The full SuperBrain analysis pipeline (Instagram download, Whisper, vision) needs `server/requirements.txt` and `python start.py` once for its setup wizard; Qivra pairing does not.

## Develop

Requirements: Node 20+, JDK 17–21, Android SDK (platform 36, build-tools 36), Python 3.11+ for the server.

```bash
npm ci
npx tsc --noEmit                 # type-check
npx biome lint src App.tsx index.ts __tests__ plugins
npx jest                         # unit, DB, integration (starts the real server) and UI tests
cd server && .venv/bin/python -m pytest -q tests
```

### Build the APK

```bash
export JAVA_HOME=/path/to/jdk-21 ANDROID_HOME=/path/to/android-sdk
QIVRA_ANDROID_ABIS=arm64-v8a,x86_64 npx expo prebuild --platform android --clean --no-install
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

`QIVRA_NDK_VERSION` pins the NDK if the default one is not installed. `android/` is generated — change native config in `plugins/withQivraAndroid.js`, not in `android/`.

### Emulator / device testing

- Emulator: `avdmanager create avd -n qivra -k "system-images;android-35;google_apis;arm64-v8a"`, `emulator -avd qivra`, `adb install dist/Qivra-*.apk`. The emulator reaches the laptop server at `http://10.0.2.2:<port>`.
- USB phone with the server in localhost mode: `adb reverse tcp:5001 tcp:5001`, then use `http://127.0.0.1:5001`.
- Same Wi-Fi: `python -m qivra serve --lan`; allow incoming connections for Python in the firewall.

## Permissions

| Permission | Why | When asked |
|---|---|---|
| INTERNET, ACCESS_NETWORK_STATE | metadata lookups, your server, your AI endpoint | install time |
| CAMERA | scanning the pairing QR | only when you tap "Scan QR code" |
| POST_NOTIFICATIONS | optional daily review reminder | only when you turn the reminder on |
| RECEIVE_BOOT_COMPLETED, WAKE_LOCK | WorkManager background processing | install time |
| VIBRATE | declared by expo-notifications | install time |

No storage, microphone or location permission: files come through Android's document picker / share sheet (content URIs).

## Troubleshooting

- **"Not a Qivra server"** — wrong port; the server picks 5001 if 5000 is taken (macOS AirPlay). Copy the printed URL.
- **Timeouts on Wi-Fi** — firewall, guest network, or client isolation on the router.
- **Code expired/used** — press Enter in the server terminal or `python -m qivra pair --port <port>`.
- **Device revoked** — Disconnect in the app and pair again.
- **Expo Go** — not supported (the project is SDK 54 and needs native share code); use the APK.

## License

AGPL-3.0 (inherited from SuperBrain). See `LICENSE` and the licensing section of the migration document.
