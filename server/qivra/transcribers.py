"""Pluggable speech-to-text engines for the server.

Order for QIVRA_TRANSCRIBER=auto (default):
  1. transcribe-anything (https://github.com/zackees/transcribe-anything, BSD-3-Clause for pinned 4.1.2)
     — preferred on Apple Silicon, where it uses the MLX backend; also cpu/cuda.
  2. faster-whisper (in-process, CPU int8).
  3. SuperBrain's analyzers.audio_transcribe (Groq Whisper API / openai-whisper).
Set QIVRA_TRANSCRIBER to one of: auto, transcribe-anything, faster-whisper, superbrain.
Every engine returns real segments with millisecond timestamps when it has them.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import platform
import shutil
import sysconfig
import tempfile
import threading
from pathlib import Path

from .transcripts import TranscriptParseError, parse_srt

logger = logging.getLogger(__name__)


class TranscriberError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def _model() -> str:
    return os.getenv("QIVRA_WHISPER_MODEL", "base")


def apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def available_engines() -> list[str]:
    engines = []
    if importlib.util.find_spec("transcribe_anything") is not None:
        engines.append("transcribe-anything")
    if importlib.util.find_spec("faster_whisper") is not None:
        engines.append("faster-whisper")
    engines.append("superbrain")
    return engines


def selected_engine() -> str:
    wanted = os.getenv("QIVRA_TRANSCRIBER", "auto").strip().lower()
    engines = available_engines()
    if wanted != "auto":
        if wanted not in engines:
            raise TranscriberError("TRANSCRIBER_UNAVAILABLE", f"Transcriber '{wanted}' is not installed on the server.")
        return wanted
    # transcribe-anything shines with MLX on Apple Silicon (or CUDA); elsewhere faster-whisper is lighter.
    if "transcribe-anything" in engines and (apple_silicon() or os.getenv("QIVRA_TA_DEVICE")):
        return "transcribe-anything"
    if "faster-whisper" in engines:
        return "faster-whisper"
    if "transcribe-anything" in engines:
        return "transcribe-anything"
    return "superbrain"


def describe() -> dict:
    try:
        engine = selected_engine()
    except TranscriberError:
        engine = None
    device = (os.getenv("QIVRA_TA_DEVICE") or ("mlx" if apple_silicon() else "cpu")) if engine == "transcribe-anything" else "cpu"
    return {"engine": engine, "model": _model(), "device": device, "available": available_engines()}


# ── engines ───────────────────────────────────────────────────────────────────
def _ta_transcribe(path: Path) -> tuple[list[dict], str, str]:
    from transcribe_anything import transcribe  # type: ignore

    # The Python API shells out to its static_ffmpeg console script. Launching
    # with .venv/bin/python does not activate that environment's bin directory.
    scripts = sysconfig.get_path("scripts")
    paths = os.environ.get("PATH", "").split(os.pathsep)
    if scripts not in paths:
        os.environ["PATH"] = os.pathsep.join([scripts, *paths])

    device = os.getenv("QIVRA_TA_DEVICE") or ("mlx" if apple_silicon() else "cpu")
    out = Path(tempfile.mkdtemp(prefix="ta_"))
    try:
        try:
            transcribe(url_or_file=str(path), output_dir=str(out), model=_model(), device=device)
        except Exception as exc:
            raise TranscriberError("TRANSCRIPTION_FAILED", f"transcribe-anything failed ({type(exc).__name__}).", True) from exc
        srt = out / "out.srt"
        if not srt.exists() or not srt.read_text(encoding="utf-8", errors="replace").strip():
            return [], "und", f"transcribe-anything-{device}-{_model()}"
        try:
            segs = parse_srt(srt.read_text(encoding="utf-8", errors="replace"))
        except TranscriptParseError:
            segs = []
        language = "und"
        meta = out / "out.json"
        if meta.exists():
            import json
            try:
                language = json.loads(meta.read_text(encoding="utf-8")).get("language") or "und"
            except ValueError:
                pass
        return segs, language, f"transcribe-anything-{device}-{_model()}"
    finally:
        shutil.rmtree(out, ignore_errors=True)


_fw_model = None
_fw_lock = threading.Lock()


def _fw_transcribe(path: Path) -> tuple[list[dict], str, str]:
    global _fw_model
    from faster_whisper import WhisperModel

    with _fw_lock:
        if _fw_model is None:
            _fw_model = WhisperModel(_model(), device="cpu", compute_type="int8")
        model = _fw_model
    try:
        segments, info = model.transcribe(str(path), vad_filter=True, beam_size=1)
        segs = [{"start_ms": int(s.start * 1000), "end_ms": int(s.end * 1000), "text": s.text.strip()}
                for s in segments if s.text and s.text.strip()]
    except IndexError as exc:  # container without an audio stream
        raise TranscriberError("NO_AUDIO", "This file has no audio track.") from exc
    except Exception as exc:
        raise TranscriberError("TRANSCRIPTION_FAILED", f"Transcription failed ({type(exc).__name__}).", True) from exc
    return segs, info.language or "und", f"faster-whisper-{_model()}"


def _sb_transcribe(path: Path) -> tuple[list[dict], str, str]:
    from .jobs import JobFailure, transcribe_media

    try:
        text, lang, provider = transcribe_media(str(path))
    except JobFailure as exc:
        raise TranscriberError(exc.code, exc.message) from exc
    return [{"start_ms": None, "end_ms": None, "text": text}], lang, provider


ENGINES = {"transcribe-anything": _ta_transcribe, "faster-whisper": _fw_transcribe, "superbrain": _sb_transcribe}


def transcribe_file(path: Path) -> tuple[list[dict], str, str]:
    """Return (segments, language, provider) using the selected engine."""
    engine = selected_engine()
    try:
        return ENGINES[engine](Path(path))
    except TranscriberError as exc:
        # Auto mode must remain usable if TA's isolated runtime cannot provision
        # itself. Fall back only to another local engine; never opt into cloud.
        if (os.getenv("QIVRA_TRANSCRIBER", "auto").strip().lower() == "auto"
                and engine == "transcribe-anything" and "faster-whisper" in available_engines()):
            logger.warning("transcribe-anything failed (%s); using local faster-whisper.", exc.code)
            return ENGINES["faster-whisper"](Path(path))
        raise
