# AI providers and transcripts

## Without any AI (default)

Qivra is fully usable with no model:

- **Local extraction** (`src/core/enrich.ts`, label "Extracted on device"): extractive summary (real sentences from the source), key points, tools/frameworks (dictionary match), commands (from code spans, `$ ` lines and spoken "run npm …" phrases), GitHub repositories, URLs, suggested tags, action items, timestamped highlights. Commands are copied verbatim, flagged when potentially destructive (`rm -rf`, `dd`, `mkfs`, force-push, `DROP TABLE`, `curl | sh`, `sudo`, …) and **never executed**.
- **Agent:** answers are assembled from matching items and transcript passages with numbered citations, clearly marked "no AI model".
- **Reports:** built entirely from saved data; the executive summary says it is computed, not generated.

## Optional providers

### On the phone — any OpenAI-compatible endpoint (`src/core/ai/provider.ts`)

Settings → AI models: base URL, chat model, optional embedding model, optional API key (Keystore). Presets: Groq gpt-oss, Mistral, Gemini, OpenRouter (your own key, hosted) and Ollama or LM Studio on your laptop (free, local). Presets also fill the embedding model where the provider has one. Rules:

- `http://` is allowed only to private/LAN/VPN addresses; public endpoints must be `https://`.
- Endpoints outside your network require explicit consent ("content leaves your network") before anything is sent; the test button sends no saved content.
- Calls and provider-reported token counts are recorded (`usage_events`) and shown; Qivra does not know your provider's prices.
- Model output never replaces evidence: commands, repos, URLs and timestamps stay from local extraction (`mergeModelEnrichment`). Summaries are labelled "AI-generated".
- Embedding model → semantic search in the agent (cosine similarity fused with keyword ranking via RRF); embeddings are computed by the `embed` job.

### Through the paired server — AI gateway (1.3.0, recommended for hosted keys)

Put the provider in `server/qivra.env` (git-ignored; template `server/qivra.env.example`): `QIVRA_AI_BASE_URL`, `QIVRA_AI_API_KEY`, `QIVRA_AI_MODEL`, optional `QIVRA_AI_EMBEDDING_MODEL`. `python -m qivra serve` loads it and prints "AI for paired phones: <model> via <host>" (never the key).

- The phone needs no setup: when it has no model of its own, `src/services/ai.ts` uses `<server>/api/v1/ai/chat/completions` (and `/embeddings`) with its device credential. The key never reaches the phone, the APK, the QR code, sync or logs (tested).
- The server forces the configured model, forwards only allow-listed fields, caps `max_tokens` at 4096, and maps upstream errors to its own codes without relaying the upstream body.
- With the gateway, new items get AI summaries automatically (`model_enrich`), and server jobs (enrichment, agent, reports) use it too.
- A model configured on the phone still takes precedence. Configuring the key on the server is the owner's consent to send AI requests to that provider; the AI models screen shows which provider is in use.
- Hosted providers must use `https://`. Recommended: Groq `openai/gpt-oss-120b` (verified against Groq's model list 2026-10-21; Groq has no embeddings) or Mistral `mistral-small-latest` + `mistral-embed`.

### On the paired server — SuperBrain's ModelRouter (fallback when no gateway is configured)

Server enrichment (`process kind=enrich`) and server agent answers use `core/model_router.py` (Groq, Gemini, OpenRouter keys in `server/config/.api_keys`, or Ollama). `server/qivra/ai.py` reports Ollama as available only if it actually answers on `OLLAMA_HOST`. No provider → job fails with `NO_PROVIDER` (not a fake success).

On-device LLM inference was evaluated and not implemented: running a useful model on typical Android hardware needs a native runtime (llama.cpp/MLC) that is not available as a maintained Expo module and would add hundreds of MB.

## Automatic transcripts for shared videos (1.1.0)

1. **YouTube:** the phone asks YouTube's player endpoint (the Android client) for the caption tracks YouTube publishes and downloads one (human captions in your language > the video's auto-captions > any) — `src/core/youtubeCaptions.ts`.
2. **Instagram, X, and YouTube without captions:** if paired and "Auto-transcribe shared videos" is on (default), the app queues a `transcribe_url` job on the server (`server/qivra/media.py`): yt-dlp fetches only the audio of the public post (allow-listed hosts, no cookies, ≤ 60 min, ≤ 300 MB), the configured speech-to-text engine transcribes it with timestamps and language detection (see *Server transcription engines* below), the temp file is deleted. The phone polls the job and pulls the transcript plus post details (title, uploader, caption, thumbnail).
3. **Honest outcomes:** music-only / silent / image posts → `NO_SPEECH` / `NO_AUDIO` / `NO_MEDIA_IN_POST` → item is Ready with "No speech to transcribe"; private or login-gated → `LOGIN_REQUIRED`; platform bot checks → `BOT_CHECK` (retried); not paired → the page explains and offers Connect / Import transcript.
4. **Websites / GitHub:** readable article text (or README) is extracted on the phone and stored as an "article" record, so it is searchable, summarised and highlighted.
5. **Highlights:** `src/core/highlights.ts` ranks detected tools and recurring terms, finds the timestamped lines (or sentences) that mention them, and the UI marks every occurrence; YouTube timestamps open the video at that second.

### Server transcription engines (`server/qivra/transcribers.py`)

Chosen with `QIVRA_TRANSCRIBER` in `server/qivra.env` (or the environment); the startup banner prints the active engine on the `Transcription:` line, and `/api/v1/pairing/status` reports it under `transcription` (`engine`, `model`, `cloud`, `fallback`).

| `QIVRA_TRANSCRIBER` | What happens | Audio leaves the machine? |
|---|---|---|
| `groq` | Groq's hosted Whisper (`whisper-large-v3-turbo`, override with `QIVRA_GROQ_WHISPER_MODEL`): multipart upload to `{QIVRA_AI_BASE_URL}/audio/transcriptions` with `response_format=verbose_json`, using the gateway key. Segments keep start/end times; the language name is stored as an ISO code (`English` → `en`); provider `groq-whisper-large-v3-turbo`. Only offered when `QIVRA_AI_BASE_URL` is `https://api.groq.com/openai/v1` and a key is set. If Groq fails — unreachable, 429 rate limit, 5xx, rejected key, invalid response, or audio over 25 MB (not uploaded) — the server falls back to transcribe-anything, then faster-whisper. | Yes, to Groq (the key stays on the server and is never logged or sent to phones) |
| `auto` (default) | transcribe-anything (MLX on Apple Silicon) → faster-whisper if it fails; elsewhere faster-whisper. Never picks Groq. | No |
| `transcribe-anything` / `faster-whisper` | That local engine only, no fallback. | No |
| `superbrain` | SuperBrain's legacy analyzer (may itself call Groq). | Depends |

Local engines never fall back to a cloud engine. A reel takes roughly a minute with local Whisper on a laptop and a few seconds with Groq. Live check: `QIVRA_LIVE=1 .venv/bin/python -m pytest -q -s tests/test_qivra_transcribers.py -k live` (sends a generated WAV to Groq).

### Text in images and on screen (OCR)

- **Shared screenshots and photos (phone, offline):** the share target accepts `image/*` (≤ 30 MB each, SVG refused). Images shared together become one note item with the images as media (a swipeable hero on the item page); a caption shared with them becomes the note. Before enrichment, `src/services/ocr.ts` reads the text on the device with Google ML Kit text recognition (`@react-native-ml-kit/text-recognition`, MIT, bundled models, no network; script picked from the phone language: Latin, Chinese, Devanagari, Japanese, Korean) and stores it as a transcript with source `image_ocr` — one segment per image, treated as text (like `web_article`), so it feeds search, summaries, key points and flashcards. No text found → Ready with "No text was found in this image"; a build without the native module → Ready with "Text recognition is not available in this build". Needs a prebuild/rebuild after install; the five ML Kit script models add to the APK size.
- **Reels with on-screen text (server, optional):** install `pip install -r requirements-ocr.txt` (RapidOCR, `rapidocr-onnxruntime`, Apache-2.0, ONNX Runtime on the CPU). When speech transcription ends with `NO_SPEECH` / `NO_AUDIO` or under 25 characters, `transcribe_url` downloads a ≤ 720p video rendition (same allow-listed hosts, no cookies), samples a frame every 2 s with PyAV (`QIVRA_OCR_EVERY_S`, at most `QIVRA_OCR_MAX_FRAMES`=150), reads each frame and de-duplicates text that stays on screen (`server/qivra/video_ocr.py`): each segment's `start_ms` is when that text first appeared; watermarks and repeated captions are kept once. It is stored as a `video_ocr` transcript (provider `rapidocr`, language `und`) next to any speech transcript, and the phone imports it as `server_video_ocr` with timestamps. Without RapidOCR (or if the video cannot be downloaded) the result is exactly as before: `NO_SPEECH` / `NO_AUDIO`. Live check: `QIVRA_LIVE=1 .venv/bin/python -m pytest -q tests/test_qivra_video_ocr.py -k live` (generated image and video, no network).

## Transcripts

| Source | How | Notes |
|---|---|---|
| SRT / WebVTT / TXT file | Share sheet, or Add transcript → file (document picker / SAF) | ≤ 5 MB; parsed on device |
| Pasted text | Capture → Transcript, or item → Add transcript | `[mm:ss] text` lines keep timestamps |
| YouTube captions | Item → "Captions via server" | Server job using the optional `youtube-transcript-api`; only captions YouTube publishes; fails honestly with `CAPTIONS_UNAVAILABLE` / `CAPTIONS_NOT_FOUND` |
| Shared screenshots / photos | Share sheet (`image/*`) | On-device OCR → source `image_ocr` (see *Text in images and on screen*) |
| On-screen text of a reel without speech | Automatic, with `requirements-ocr.txt` on the server | Source `video_ocr`, timestamped per sampled frame |
| Audio/video you are allowed to process | Share or Capture → Audio/video (≤ 200 MB), then "Transcribe on server" (explicit, confirmed upload) | Server engine from `QIVRA_TRANSCRIBER` (Groq Whisper with local fallback, or local only) |
| Instagram | — | Not downloaded by Qivra. Save the link, add your own transcript, or use SuperBrain's legacy analyzer on the server with your own account at your own risk |

Parsing (`src/core/transcripts.ts`, mirrored in `server/qivra/transcripts.py`): tags/entities stripped, rolling-caption duplicates merged, timestamps kept only when present in the source. Chunks for search never split a timed segment, so every hit has a real time range.

Language: provider language > user choice > offline heuristic (`src/core/language.ts`: script detection for Indic/CJK/Arabic/Cyrillic + stop-word scoring for Latin languages), labelled "detected"; correctable per transcript. Originals and translations are separate records (`kind=original|translation`); importing a translation never alters the original. Corrections replace segment text, keep timestamps, set `corrected`, and re-index. Re-imports with the same item/language/kind/source replace the record — retries never duplicate.

Qivra never shows a transcript it did not receive: no synthetic text, no fake progress.
