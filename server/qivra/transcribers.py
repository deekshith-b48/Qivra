"""Pluggable speech-to-text engines for the server.

QIVRA_TRANSCRIBER=groq sends the audio to Groq's hosted Whisper (whisper-large-v3-turbo,
override with QIVRA_GROQ_WHISPER_MODEL) using the server's AI gateway key; it is offered only
when QIVRA_AI_BASE_URL points at api.groq.com. If Groq fails (network, 429, 5xx, rejected key,
file over 25 MB) the server falls back to the local engines: transcribe-anything, then
faster-whisper. Local engines never fall back to a cloud engine.

Order for QIVRA_TRANSCRIBER=auto (default, local only):
  1. transcribe-anything (https://github.com/zackees/transcribe-anything, BSD-3-Clause for pinned 4.1.2)
     — preferred on Apple Silicon, where it uses the MLX backend; also cpu/cuda.
  2. faster-whisper (in-process, CPU int8).
  3. SuperBrain's analyzers.audio_transcribe (Groq Whisper API / openai-whisper).
Set QIVRA_TRANSCRIBER to one of: auto, groq, transcribe-anything, faster-whisper, superbrain.
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


GROQ_HOST = "api.groq.com"
GROQ_MAX_BYTES = 25 * 1024 * 1024  # Groq's upload limit on the free/on-demand tier
LOCAL_FALLBACK = ("transcribe-anything", "faster-whisper")


def _groq_model() -> str:
    return os.getenv("QIVRA_GROQ_WHISPER_MODEL", "").strip() or "whisper-large-v3-turbo"


def _groq_config() -> dict | None:
    """The gateway config when it points at Groq with a key; None otherwise."""
    from . import ai_gateway

    cfg = ai_gateway.config()
    if cfg is None or cfg["host"] != GROQ_HOST or not cfg["api_key"]:
        return None
    return cfg


def available_engines() -> list[str]:
    engines = []
    if _groq_config() is not None:
        engines.append("groq")
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
    available = available_engines()
    if engine == "groq":
        return {"engine": engine, "model": _groq_model(), "device": "cloud", "cloud": True,
                "fallback": [e for e in LOCAL_FALLBACK if e in available], "available": available}
    device = (os.getenv("QIVRA_TA_DEVICE") or ("mlx" if apple_silicon() else "cpu")) if engine == "transcribe-anything" else "cpu"
    return {"engine": engine, "model": _model(), "device": device, "cloud": False, "available": available}


def banner() -> str:
    """One line for the server's startup banner."""
    info = describe()
    if info["engine"] is None:
        return f"unavailable (QIVRA_TRANSCRIBER={os.getenv('QIVRA_TRANSCRIBER', 'auto')} is not installed)"
    if info["engine"] == "groq":
        fallback = f"local fallback: {', '.join(info['fallback'])}" if info["fallback"] else "no local fallback installed"
        return f"Groq {info['model']} (audio is sent to Groq), {fallback}"
    return f"{info['engine']} {info['model']} on {info['device']} (local)"


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


# Whisper reports the language by name in verbose_json ("English"); store ISO 639-1 codes.
_LANGUAGE_CODES = {
    "english": "en", "hindi": "hi", "kannada": "kn", "tamil": "ta", "telugu": "te", "malayalam": "ml",
    "marathi": "mr", "bengali": "bn", "gujarati": "gu", "punjabi": "pa", "urdu": "ur", "nepali": "ne",
    "sinhala": "si", "spanish": "es", "french": "fr", "german": "de", "italian": "it", "portuguese": "pt",
    "dutch": "nl", "russian": "ru", "ukrainian": "uk", "polish": "pl", "czech": "cs", "swedish": "sv",
    "norwegian": "no", "danish": "da", "finnish": "fi", "greek": "el", "turkish": "tr", "arabic": "ar",
    "hebrew": "he", "persian": "fa", "chinese": "zh", "japanese": "ja", "korean": "ko", "vietnamese": "vi",
    "thai": "th", "indonesian": "id", "malay": "ms", "tagalog": "tl", "romanian": "ro", "hungarian": "hu",
    "catalan": "ca", "swahili": "sw", "afrikaans": "af", "cantonese": "yue",
}


def _language_code(value) -> str:
    name = str(value or "").strip().lower()
    if not name:
        return "und"
    if name in _LANGUAGE_CODES.values():
        return name
    return _LANGUAGE_CODES.get(name, "und")


def _to_flac_16k(src: Path, dst: Path) -> bool:
    """Re-encode any audio/video file to 16 kHz mono FLAC with PyAV. Returns False if not possible.

    Groq sniffs uploads and rejects some valid containers (e.g. the fragmented MP4
    audio X serves), while 16 kHz mono FLAC is accepted and is what Whisper uses anyway
    (about 1 MB per minute, so 25 MB is roughly 20+ minutes of speech).
    """
    try:
        import av
    except ImportError:
        return False
    try:
        with av.open(str(src)) as inp, av.open(str(dst), "w", format="flac") as out:
            stream = next((s for s in inp.streams if s.type == "audio"), None)
            if stream is None:
                return False
            enc = out.add_stream("flac", rate=16000, layout="mono")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for frame in inp.decode(stream):
                for f in resampler.resample(frame):
                    for pkt in enc.encode(f):
                        out.mux(pkt)
            for f in resampler.resample(None):
                for pkt in enc.encode(f):
                    out.mux(pkt)
            for pkt in enc.encode(None):
                out.mux(pkt)
        return dst.stat().st_size > 0
    except Exception as exc:  # undecodable input: send the original instead
        logger.info("Could not convert audio for Groq (%s); uploading the original.", type(exc).__name__)
        return False


def _groq_transcribe(path: Path) -> tuple[list[dict], str, str]:
    work = Path(tempfile.mkdtemp(prefix="groq_"))
    try:
        flac = work / "audio.flac"
        if _to_flac_16k(Path(path), flac):
            return _groq_upload(flac, "audio/flac")
        return _groq_upload(Path(path), "application/octet-stream")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _groq_upload(path: Path, content_type: str) -> tuple[list[dict], str, str]:
    import httpx

    cfg = _groq_config()
    if cfg is None:
        raise TranscriberError("TRANSCRIBER_UNAVAILABLE", "Groq transcription needs QIVRA_AI_BASE_URL=https://api.groq.com/openai/v1 and a key.")
    model = _groq_model()
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise TranscriberError("NO_MEDIA", "The audio file is missing.") from exc
    if size > GROQ_MAX_BYTES:
        raise TranscriberError("GROQ_FILE_TOO_LARGE", f"Audio is {size // (1024 * 1024)} MB; Groq accepts up to 25 MB.")
    try:
        with path.open("rb") as fh:
            res = httpx.post(
                cfg["base_url"] + "/audio/transcriptions",
                headers={"Authorization": f"Bearer {cfg['api_key']}"},
                files={"file": (path.name, fh, content_type)},
                data={"model": model, "response_format": "verbose_json", "temperature": "0"},
                timeout=180.0,
            )
    except httpx.HTTPError as exc:
        raise TranscriberError("GROQ_UNREACHABLE", f"Could not reach Groq ({type(exc).__name__}).", True) from exc
    if res.status_code in (401, 403):
        raise TranscriberError("GROQ_KEY_REJECTED", "Groq rejected the server's API key.")
    if res.status_code == 413:
        raise TranscriberError("GROQ_FILE_TOO_LARGE", "Groq refused the audio file as too large.")
    if res.status_code == 429:
        raise TranscriberError("GROQ_RATE_LIMITED", "Groq's rate limit was reached.", True)
    if res.status_code >= 400:
        raise TranscriberError("GROQ_ERROR", f"Groq returned HTTP {res.status_code}.", res.status_code >= 500)
    try:
        body = res.json()
    except ValueError as exc:
        raise TranscriberError("GROQ_BAD_RESPONSE", "Groq returned invalid JSON.", True) from exc
    segs = []
    for s in body.get("segments") or []:
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        try:
            start, end = int(float(s["start"]) * 1000), int(float(s["end"]) * 1000)
        except (KeyError, TypeError, ValueError):
            start = end = None
        segs.append({"start_ms": start, "end_ms": end, "text": text})
    if not segs and str(body.get("text") or "").strip():
        segs = [{"start_ms": None, "end_ms": None, "text": body["text"].strip()}]
    return segs, _language_code(body.get("language")), f"groq-{model}"


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


ENGINES = {"groq": _groq_transcribe, "transcribe-anything": _ta_transcribe, "faster-whisper": _fw_transcribe, "superbrain": _sb_transcribe}


def transcribe_file(path: Path) -> tuple[list[dict], str, str]:
    """Return (segments, language, provider) using the selected engine."""
    engine = selected_engine()
    if engine == "groq":
        return _cloud_then_local(Path(path))
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


def _cloud_then_local(path: Path) -> tuple[list[dict], str, str]:
    """Groq first; on any Groq failure, the local engines in order. Never another cloud engine."""
    try:
        return ENGINES["groq"](path)
    except TranscriberError as exc:
        error = exc
        logger.warning("Groq transcription failed (%s); falling back to local engines.", exc.code)
    available = available_engines()
    for local in LOCAL_FALLBACK:
        if local not in available:
            continue
        try:
            return ENGINES[local](path)
        except TranscriberError as exc:
            if exc.code == "NO_AUDIO":
                raise
            error = exc
            logger.warning("%s failed (%s).", local, exc.code)
    raise error
