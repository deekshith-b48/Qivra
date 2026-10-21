"""Durable background jobs for server-side processing.

Jobs live in `qv_jobs`, so they survive restarts (running jobs are re-queued on
boot). Job ids are idempotency keys supplied by the client, so a retried request
never creates a duplicate job or duplicate transcript. Heavy work never runs in
the request handler.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time

from . import ai
from .knowledge import SYSTEM_RULES, neutralise
from .metadata import UnsafeUrlError, fetch_metadata
from .store import QivraStore
from .transcripts import segments_to_text
from .util import now_iso

log = logging.getLogger("qivra.jobs")

JOB_KINDS = ("metadata", "captions", "transcribe", "transcribe_url", "enrich")
ENRICHMENT_VERSION = 1


class JobFailure(Exception):
    def __init__(self, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class JobRunner:
    def __init__(self, store: QivraStore, poll_s: float = 1.0):
        self.store = store
        self.poll_s = poll_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        recovered = self.store.recover_running_jobs()
        if recovered:
            log.info("Re-queued %d interrupted job(s)", recovered)
        self._thread = threading.Thread(target=self._loop, name="qivra-jobs", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                if not self.run_once():
                    time.sleep(self.poll_s)
            except Exception:  # never let the worker die
                log.exception("job loop error")
                time.sleep(self.poll_s)

    def run_once(self) -> bool:
        job = self.store.next_queued_job()
        if job is None:
            return False
        try:
            result = self.execute(job)
            self.store.finish_job(job["id"], "succeeded", result=result)
        except JobFailure as f:
            status = "failed_retryable" if f.retryable else "failed_permanent"
            self.store.finish_job(job["id"], status, error_code=f.code, error_message=f.message)
        except Exception as exc:
            log.warning("job %s crashed: %s", job["id"], type(exc).__name__)
            self.store.finish_job(job["id"], "failed_retryable", error_code="INTERNAL",
                                  error_message=type(exc).__name__)
        return True

    # ── handlers ─────────────────────────────────────────────────────────
    def execute(self, job: dict) -> dict:
        item = self.store.get_entity("item", job["item_id"])
        if item is None or item["deleted"]:
            raise JobFailure("ITEM_NOT_FOUND", "Item no longer exists.", False)
        handler = getattr(self, f"_job_{job['kind']}", None)
        if handler is None:
            raise JobFailure("UNKNOWN_JOB", f"Unknown job kind {job['kind']}", False)
        return handler(item)

    def _job_metadata(self, item: dict) -> dict:
        url = item["data"].get("url")
        if not url:
            raise JobFailure("NO_URL", "Item has no URL.", False)
        try:
            meta = fetch_metadata(url)
        except UnsafeUrlError as exc:
            raise JobFailure("URL_REFUSED", str(exc), False) from exc
        except Exception as exc:
            raise JobFailure("FETCH_FAILED", f"Could not fetch metadata ({type(exc).__name__}).", True) from exc
        patch = {"metadata": {**meta, "fetchedAt": now_iso(), "provider": "server:html-meta"}}
        if not item["data"].get("title") and meta.get("title"):
            patch["title"] = meta["title"]
        self.store.server_update_item(item["id"], patch)
        return {"metadata": meta}

    def _job_captions(self, item: dict) -> dict:
        url = item["data"].get("url") or ""
        m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{11})", url)
        if not m:
            raise JobFailure("CAPTIONS_UNSUPPORTED", "Caption import is only available for YouTube links.", False)
        try:
            from youtube_transcript_api import YouTubeTranscriptApi  # optional dependency
        except ImportError as exc:
            raise JobFailure("CAPTIONS_UNAVAILABLE",
                             "Caption import is not installed on the server (pip install youtube-transcript-api). "
                             "Import a transcript file instead.", False) from exc
        try:
            fetched = YouTubeTranscriptApi().fetch(m.group(1))
            segs = [{"start_ms": int(s.start * 1000), "end_ms": int((s.start + s.duration) * 1000), "text": s.text}
                    for s in fetched]
            language = getattr(fetched, "language_code", "und") or "und"
        except Exception as exc:
            raise JobFailure("CAPTIONS_NOT_FOUND",
                             f"No captions are available for this video ({type(exc).__name__}).", False) from exc
        tr = self.store.upsert_transcript(item["id"], text=segments_to_text(segs), segments=segs,
                                          language=language, kind="original", source="youtube_captions",
                                          provider="youtube-transcript-api")
        return {"transcript_id": tr["id"], "segments": len(segs), "language": language}

    def _job_transcribe(self, item: dict) -> dict:
        media = self.store.latest_media(item["id"])
        if media is None:
            raise JobFailure("NO_MEDIA", "Upload an audio or video file for this item first.", False)
        text, language, provider = transcribe_media(media["path"])
        tr = self.store.upsert_transcript(item["id"], text=text, segments=[], language=language or "und",
                                          kind="original", source="server_whisper", provider=provider)
        return {"transcript_id": tr["id"], "chars": len(text), "language": language, "provider": provider}

    def _job_transcribe_url(self, item: dict) -> dict:
        from .config import get_config
        from .media import MediaError, clean_caption, transcribe_url
        url = item["data"].get("url") or ""
        if not url:
            raise JobFailure("NO_URL", "Item has no URL.", False)
        try:
            out = transcribe_url(url, get_config().data_dir)
        except MediaError as exc:
            meta = getattr(exc, "meta", None)
            if meta:
                self._apply_post_meta(item, meta)
            raise JobFailure(exc.code, exc.message, exc.retryable) from exc
        segs = out["segments"]
        tr = self.store.upsert_transcript(item["id"], text=segments_to_text(segs), segments=segs,
                                          language=out["language"], kind="original", source="server_whisper",
                                          provider=out["provider"])
        meta = self._apply_post_meta(item, out["meta"])
        return {"transcript_id": tr["id"], "segments": len(segs), "language": out["language"],
                "provider": out["provider"], "meta": meta}

    def _apply_post_meta(self, item: dict, meta: dict) -> dict:
        from .media import clean_caption
        meta = {**meta, "description": clean_caption(meta.get("description", ""))}
        patch = {"metadata": {**(item["data"].get("metadata") or {}), **meta, "fetchedAt": now_iso(),
                              "provider": "server:yt-dlp"}}
        if not item["data"].get("title") and meta.get("title"):
            patch["title"] = meta["title"]
        self.store.server_update_item(item["id"], patch)
        return meta

    def _job_enrich(self, item: dict) -> dict:
        if not ai.provider_status()["available"]:
            raise JobFailure("NO_PROVIDER", "No AI provider is configured on the server.", False)
        d = item["data"]
        transcripts = self.store.list_transcripts(item["id"])
        body = "\n".join(t["text"] for t in transcripts if t["kind"] == "original")[:12000]
        prompt = (
            SYSTEM_RULES + "\n\nExtract structured knowledge from the single SOURCE below. Respond with ONLY a JSON "
            'object with keys: "summary" (string), "keyPoints" (string[]), "concepts" (string[]), "tools" '
            '(string[]), "commands" (string[]), "repos" (string[] of owner/name), "tags" (string[]), '
            '"followUpQuestions" (string[]), "actionItems" (string[]). Use only information present in the source.'
            f'\n\n<source id="S1">\nTitle: {neutralise(d.get("title", ""), 300)}\nURL: {neutralise(d.get("url", ""), 300)}'
            f"\nNote: {neutralise(d.get('note', ''), 2000)}\nText: {neutralise(body, 12000)}\n</source>\n\nJSON:"
        )
        try:
            raw, provider = ai.generate(prompt)
        except Exception as exc:
            raise JobFailure("PROVIDER_FAILED", f"AI provider failed ({type(exc).__name__}).", True) from exc
        parsed = parse_enrichment_json(raw)
        if parsed is None:
            raise JobFailure("BAD_MODEL_OUTPUT", "The model did not return valid JSON.", True)
        enrichment = {**parsed, "version": ENRICHMENT_VERSION, "provider": provider, "generatedAt": now_iso(),
                      "origin": "model"}
        self.store.server_update_item(item["id"], {"enrichment": enrichment})
        return {"enrichment": enrichment}


def transcribe_media(path: str) -> tuple[str, str, str]:
    """Adapter over SuperBrain's transcriber: Groq Whisper API first, then local Whisper.

    Returns (text, language_code, provider). Raises JobFailure when no engine works.
    """
    from pathlib import Path

    try:
        from analyzers import audio_transcribe as at
    except Exception as exc:
        raise JobFailure("TRANSCRIBER_UNAVAILABLE", "Transcription module failed to load.", False) from exc
    p = Path(path)
    errors = []
    key = at._load_groq_key()
    if key:
        try:
            text, lang = at._transcribe_groq(p, key)
            if text and text.strip():
                return text.strip(), lang or "und", "groq-whisper"
        except Exception as exc:
            errors.append(f"groq:{type(exc).__name__}")
    try:
        text, lang = at._transcribe_local(p)
        if text and text.strip():
            return text.strip(), lang or "und", f"local-whisper-{at._load_local_model()}"
    except Exception as exc:
        errors.append(f"local:{type(exc).__name__}")
    raise JobFailure("TRANSCRIBER_UNAVAILABLE",
                     "No transcription engine produced text. Configure a Groq key or install openai-whisper + "
                     f"ffmpeg on the server. ({', '.join(errors) or 'no engine'})", False)


def parse_enrichment_json(raw: str) -> dict | None:
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    out: dict = {"summary": str(obj.get("summary") or "")[:2000]}
    for key in ("keyPoints", "concepts", "tools", "commands", "repos", "tags", "followUpQuestions", "actionItems"):
        val = obj.get(key) or []
        out[key] = [str(v)[:300] for v in val if isinstance(v, (str, int, float))][:30] if isinstance(val, list) else []
    return out
