# AI providers and transcripts

## Without any AI (default)

Qivra is fully usable with no model:

- **Local extraction** (`src/core/enrich.ts`, label "Extracted on device"): extractive summary (real sentences from the source), key points, tools/frameworks (dictionary match), commands (from code spans, `$ ` lines and spoken "run npm …" phrases), GitHub repositories, URLs, suggested tags, action items, timestamped highlights. Commands are copied verbatim, flagged when potentially destructive (`rm -rf`, `dd`, `mkfs`, force-push, `DROP TABLE`, `curl | sh`, `sudo`, …) and **never executed**.
- **Agent:** answers are assembled from matching items and transcript passages with numbered citations, clearly marked "no AI model".
- **Reports:** built entirely from saved data; the executive summary says it is computed, not generated.

## Optional providers

### On the phone — any OpenAI-compatible endpoint (`src/core/ai/provider.ts`)

Settings → AI models: base URL, chat model, optional embedding model, optional API key (Keystore). Presets: Ollama or LM Studio on your laptop (free, local), Groq/OpenRouter with your own key (hosted). Rules:

- `http://` is allowed only to private/LAN/VPN addresses; public endpoints must be `https://`.
- Endpoints outside your network require explicit consent ("content leaves your network") before anything is sent; the test button sends no saved content.
- Calls and provider-reported token counts are recorded (`usage_events`) and shown; Qivra does not know your provider's prices.
- Model output never replaces evidence: commands, repos, URLs and timestamps stay from local extraction (`mergeModelEnrichment`). Summaries are labelled "AI-generated".
- Embedding model → semantic search in the agent (cosine similarity fused with keyword ranking via RRF); embeddings are computed by the `embed` job.

### On the paired server — SuperBrain's ModelRouter

Server enrichment (`process kind=enrich`) and server agent answers use `core/model_router.py` (Groq, Gemini, OpenRouter keys in `server/config/.api_keys`, or Ollama). `server/qivra/ai.py` reports Ollama as available only if it actually answers on `OLLAMA_HOST`. No provider → job fails with `NO_PROVIDER` (not a fake success).

On-device LLM inference was evaluated and not implemented: running a useful model on typical Android hardware needs a native runtime (llama.cpp/MLC) that is not available as a maintained Expo module and would add hundreds of MB.

## Automatic transcripts for shared videos (1.1.0)

1. **YouTube:** the phone asks YouTube's player endpoint (the Android client) for the caption tracks YouTube publishes and downloads one (human captions in your language > the video's auto-captions > any) — `src/core/youtubeCaptions.ts`.
2. **Instagram, X, and YouTube without captions:** if paired and "Auto-transcribe shared videos" is on (default), the app queues a `transcribe_url` job on the server (`server/qivra/media.py`): yt-dlp fetches only the audio of the public post (allow-listed hosts, no cookies, ≤ 60 min, ≤ 300 MB), faster-whisper transcribes it locally with timestamps and language detection, the temp file is deleted. The phone polls the job and pulls the transcript plus post details (title, uploader, caption, thumbnail).
3. **Honest outcomes:** music-only / silent / image posts → `NO_SPEECH` / `NO_AUDIO` / `NO_MEDIA_IN_POST` → item is Ready with "No speech to transcribe"; private or login-gated → `LOGIN_REQUIRED`; platform bot checks → `BOT_CHECK` (retried); not paired → the page explains and offers Connect / Import transcript.
4. **Websites / GitHub:** readable article text (or README) is extracted on the phone and stored as an "article" record, so it is searchable, summarised and highlighted.
5. **Highlights:** `src/core/highlights.ts` ranks detected tools and recurring terms, finds the timestamped lines (or sentences) that mention them, and the UI marks every occurrence; YouTube timestamps open the video at that second.

## Transcripts

| Source | How | Notes |
|---|---|---|
| SRT / WebVTT / TXT file | Share sheet, or Add transcript → file (document picker / SAF) | ≤ 5 MB; parsed on device |
| Pasted text | Capture → Transcript, or item → Add transcript | `[mm:ss] text` lines keep timestamps |
| YouTube captions | Item → "Captions via server" | Server job using the optional `youtube-transcript-api`; only captions YouTube publishes; fails honestly with `CAPTIONS_UNAVAILABLE` / `CAPTIONS_NOT_FOUND` |
| Audio/video you are allowed to process | Share or Capture → Audio/video (≤ 200 MB), then "Transcribe on server" (explicit, confirmed upload) | Server Whisper: Groq Whisper API (key) then local `openai-whisper` + ffmpeg |
| Instagram | — | Not downloaded by Qivra. Save the link, add your own transcript, or use SuperBrain's legacy analyzer on the server with your own account at your own risk |

Parsing (`src/core/transcripts.ts`, mirrored in `server/qivra/transcripts.py`): tags/entities stripped, rolling-caption duplicates merged, timestamps kept only when present in the source. Chunks for search never split a timed segment, so every hit has a real time range.

Language: provider language > user choice > offline heuristic (`src/core/language.ts`: script detection for Indic/CJK/Arabic/Cyrillic + stop-word scoring for Latin languages), labelled "detected"; correctable per transcript. Originals and translations are separate records (`kind=original|translation`); importing a translation never alters the original. Corrections replace segment text, keep timestamps, set `corrected`, and re-index. Re-imports with the same item/language/kind/source replace the record — retries never duplicate.

Qivra never shows a transcript it did not receive: no synthetic text, no fake progress.
