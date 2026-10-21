# Voice and transcription

Qivra adapts [OpenWhispr's](https://github.com/OpenWhispr/openwhispr) local dictation workflow to Android using `whisper.rn`. OpenWhispr's desktop Electron app is not embedded in the Android app. The companion server integrates [transcribe-anything](https://github.com/zackees/transcribe-anything) through its Python API.

## On your phone

1. Install a native Qivra build; Expo Go cannot load the speech or recording modules.
2. Open **Settings → Voice & dictation** and download a model. Whisper Base (about 60 MB) is the default. Tiny is about 32 MB, Small 190 MB, and Parakeet v3 356 MB. Downloads need internet; subsequent on-device transcription works offline.
3. Tap the mic on Today, or open **Save → Voice**, for a voice note. Tap once to record and again to stop. The recording limit is five minutes; reaching it stops capture and starts transcription automatically.
4. Use the mic in Search or the AI Agent to fill the input. Agent dictation can be edited before pressing Send. **Save → Note → Dictate note** appends speech to a written note.

Whisper supports multilingual transcription; choose the spoken language or auto-detect. Parakeet uses its own language detection and supports a narrower language set, shown in settings.

Microphone permission is requested only when recording starts. Closing the sheet or leaving the app stops capture. Closing during local transcription cancels it and ignores late results. Dictation recordings are temporary and deleted after processing; saved voice notes retain their WAV audio in app-private media storage. Delete all data includes saved voice recordings. Manage downloaded models separately in Voice & dictation.

On-device transcription does not upload audio. Library summaries and other ordinary item fields can still sync to your paired server; optional AI enrichment follows the app's existing provider settings. Pairing alone does not enable voice recording uploads. Enable **Transcribe voice notes on my server** explicitly to use server mode. Dictation always uses the phone's downloaded model.

## On your server

On Apple Silicon, from `server/`, install the core server dependencies and the optional transcription backend:

```bash
.venv/bin/pip install -r requirements-qivra.txt -r requirements-transcribe-anything.txt
UV_PYTHON=3.11 QIVRA_TRANSCRIBER=transcribe-anything QIVRA_WHISPER_MODEL=base .venv/bin/python -m qivra serve --lan
```

The optional backend is pinned to transcribe-anything 4.1.2. Its first invocation may provision an isolated Python environment, FFmpeg, and a model, requiring network access and disk space. Apple Silicon selects `mlx`; use `QIVRA_TA_DEVICE=cpu` or `cuda` for another supported backend and omit the MLX-specific `UV_PYTHON` setting. Restart the server after changing environment variables.

For the pinned MLX backend, select Python 3.11 for its isolated runtime with `UV_PYTHON=3.11` before launching the server. Its legacy `tiktoken` dependency fails to build under newer Python versions without additional build tools. This setting is supported by [uv's Python environment configuration](https://docs.astral.sh/uv/reference/environment/#uv_python). For example:

```bash
UV_PYTHON=3.11 QIVRA_TRANSCRIBER=transcribe-anything QIVRA_WHISPER_MODEL=tiny .venv/bin/python -m qivra serve --lan
```

If backend provisioning fails, use `QIVRA_TRANSCRIBER=faster-whisper` after installing `requirements-media.txt`, or leave auto mode enabled with both local engines installed.

For public video URL downloads and the lighter faster-whisper backend, also install `requirements-media.txt`. A compatible FFmpeg must be available for the URL download workflow.

`QIVRA_TRANSCRIBER` accepts `auto`, `transcribe-anything`, `faster-whisper`, or `superbrain`. Auto selects an installed backend: transcribe-anything on Apple Silicon (or with an explicit `QIVRA_TA_DEVICE`), otherwise faster-whisper when installed. Explicit selection fails with a clear error if that engine is unavailable. If transcribe-anything fails in auto mode and faster-whisper is installed, it logs the failure and retries using local faster-whisper. Explicit engine selection does not fall back. It never switches to a cloud backend during this recovery. `superbrain` can use a configured Groq cloud key, so select transcribe-anything or faster-whisper for local server inference.

Uploaded audio/video and supported public video links use the same server registry, storing transcript segments, language, and provider. Existing item processing then creates summaries, highlights, and searchable text. Private or login-gated URLs may be unavailable. General imported audio/video files use server transcription; on-device capture accepts the WAV recordings made by the Voice feature.

## Validation

Automated tests cover WAV assembly, model metadata, asynchronous microphone initialization, recording limits, server opt-in, transcript persistence, retries, and cancellation. Server tests verify backend selection and recording-upload jobs. Physical-device microphone and model inference should be checked after installing the APK; Jest uses native-module stand-ins.

Validated on 2026-10-21:

- 169 app tests passed (4 existing live tests skipped); TypeScript and Biome lint passed.
- 66 server tests passed (4 existing tests skipped).
- Android release build succeeded for arm64-v8a and x86_64; APK signature and microphone permission verified. The build uses this repository's development signing configuration.
- Real sample speech transcribed with both faster-whisper Base and transcribe-anything MLX Tiny on this Mac, with nonempty English text and timestamps. MLX required provisioning its isolated Python 3.11 environment first.
- No Android device or emulator was connected. Phone microphone capture and on-device Whisper/Parakeet inference remain unverified on hardware.
