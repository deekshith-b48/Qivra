"""On-screen text for reels without speech (optional: pip install -r requirements-ocr.txt).

Many short videos carry their message as text on screen over music. When
speech transcription finds nothing (NO_SPEECH / NO_AUDIO) or only a few words,
media.transcribe_url downloads the video and this module:
  1. samples one frame every QIVRA_OCR_EVERY_S seconds (default 2) with PyAV,
  2. reads each frame with RapidOCR (Apache-2.0, ONNX Runtime, CPU, models
     bundled in the wheel, no network),
  3. de-duplicates text that stays on screen across frames, keeping the time
     it first appeared as start_ms.
The result is stored as a transcript with source "video_ocr", so on-screen text
is searchable with timestamps. Without RapidOCR installed this does nothing.
"""

from __future__ import annotations

import difflib
import logging
import os
import re
import threading
from pathlib import Path
from typing import Callable, Iterable

logger = logging.getLogger("qivra.video_ocr")

EVERY_S = float(os.getenv("QIVRA_OCR_EVERY_S", "2"))
MAX_FRAMES = int(os.getenv("QIVRA_OCR_MAX_FRAMES", "150"))
MIN_SCORE = 0.5
MAX_SIDE = 960
SIMILAR = 0.85  # frames whose text is this similar are the same caption still on screen

Recognizer = Callable[[object], list[str]]

_engine = None
_engine_lock = threading.Lock()


def load_recognizer() -> Recognizer | None:
    """Return a frame → text-lines function, or None when RapidOCR is not installed."""
    global _engine
    with _engine_lock:
        if _engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR  # rapidocr-onnxruntime (requirements-ocr.txt)
            except ImportError:
                try:
                    from rapidocr import RapidOCR  # newer package name of the same project
                except ImportError:
                    return None
            _engine = RapidOCR()
    engine = _engine

    def recognize(img) -> list[str]:
        out = engine(img)
        if isinstance(out, tuple):  # rapidocr-onnxruntime: (result | None, elapse)
            rows = out[0] or []
            return [str(r[1]) for r in rows if len(r) >= 3 and float(r[2]) >= MIN_SCORE]
        txts = getattr(out, "txts", None) or ()  # rapidocr >= 2: RapidOCROutput
        scores = getattr(out, "scores", None) or [1.0] * len(txts)
        return [str(t) for t, s in zip(txts, scores) if float(s) >= MIN_SCORE]

    return recognize


def available() -> bool:
    return load_recognizer() is not None


def sample_frames(path: Path, every_s: float = EVERY_S, max_frames: int = MAX_FRAMES) -> Iterable[tuple[int, object]]:
    """Yield (ms, RGB ndarray) roughly every `every_s` seconds of the first video stream."""
    import av

    with av.open(str(path)) as container:
        if not container.streams.video:
            return
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        next_t = 0.0
        count = 0
        for frame in container.decode(stream):
            t = frame.time if frame.time is not None else 0.0
            if t + 1e-6 < next_t:
                continue
            scale = min(1.0, MAX_SIDE / max(frame.width, frame.height, 1))
            w, h = max(2, int(frame.width * scale) // 2 * 2), max(2, int(frame.height * scale) // 2 * 2)
            yield int(round(t * 1000)), frame.reformat(width=w, height=h, format="rgb24").to_ndarray()
            count += 1
            if count >= max_frames:
                return
            next_t = (int(t / every_s) + 1) * every_s


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", text.lower()).strip()


def _same_line(prev: str, new: str) -> bool:
    """Same on-screen line: near-identical (OCR jitter), or the new text extends it (a caption typing on)."""
    if difflib.SequenceMatcher(None, prev, new).ratio() >= SIMILAR:
        return True
    return len(prev) >= 8 and len(new) > len(prev) and difflib.SequenceMatcher(None, prev, new[: len(prev)]).ratio() >= SIMILAR


def dedupe_frame_texts(frames: list[tuple[int, list[str]]], interval_ms: int) -> list[dict]:
    """Turn per-frame OCR lines into transcript segments.

    Each line is followed while it stays on screen (tolerating OCR jitter and
    captions that type on), from the frame it first appeared in to one interval
    after it was last seen. Lines that appear together form one segment, timed
    from their first appearance. A line that comes back later (a watermark or
    @handle that blinked, a repeated caption) is not repeated. Lines without
    letters or digits are dropped.
    """
    runs: list[dict] = []
    active: list[dict] = []
    for ms, lines in sorted(frames, key=lambda f: f[0]):
        still: list[dict] = []
        for ln in (x.strip() for x in lines):
            key = _norm(ln)
            if len(key.replace(" ", "")) < 2:
                continue
            run = next((r for r in active if all(r is not x for x in still) and _same_line(r["key"], key)), None)
            if run is None:
                run = {"start_ms": ms, "key": key, "text": ln}
                runs.append(run)
            elif len(key) > len(run["key"]):  # keep the fullest version of a caption
                run.update(key=key, text=ln)
            run["end_ms"] = ms + interval_ms
            still.append(run)
        active = still

    seen: set[str] = set()
    segments: list[dict] = []
    for start in sorted({r["start_ms"] for r in runs}):
        group = [r for r in runs if r["start_ms"] == start]
        fresh = [r for r in group if r["key"] not in seen]
        seen.update(r["key"] for r in group)
        if fresh:
            # Until the first of these lines left the screen.
            segments.append({"start_ms": start, "end_ms": min(r["end_ms"] for r in group), "text": " ".join(r["text"] for r in fresh)})
    return segments


def ocr_video(path: Path, recognize: Recognizer | None = None, every_s: float = EVERY_S) -> list[dict]:
    """Sample frames from a video file and return de-duplicated, timestamped on-screen text."""
    recognize = recognize or load_recognizer()
    if recognize is None:
        return []
    frames: list[tuple[int, list[str]]] = []
    for ms, img in sample_frames(path, every_s):
        try:
            frames.append((ms, recognize(img)))
        except Exception:  # one unreadable frame should not lose the rest
            logger.debug("OCR failed on frame at %s ms", ms, exc_info=True)
    return dedupe_frame_texts(frames, int(every_s * 1000))
