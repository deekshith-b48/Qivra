"""Speech transcription for shared video links (Instagram reels, X videos, YouTube).

Pipeline (runs only inside the job worker, never in a request handler):
  1. yt-dlp downloads the *audio* of a public post into a private temp folder
     (no login cookies are used: private or login-gated posts fail honestly).
  2. faster-whisper (local, free) transcribes it with timestamps and language
     detection; SuperBrain's Groq/openai-whisper path is the fallback.
  3. The temp folder is always deleted.
Only an allow-list of video hosts is accepted, so the server cannot be used as
a general-purpose downloader or to reach private network addresses.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from .metadata import UnsafeUrlError, assert_public_http_url

ALLOWED_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com",
    "instagram.com", "www.instagram.com",
    "x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
}
MAX_SECONDS = int(os.getenv("QIVRA_MAX_MEDIA_SECONDS", "3600"))
MAX_BYTES = int(os.getenv("QIVRA_MAX_MEDIA_BYTES", str(300 * 1024 * 1024)))



class MediaError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def check_url(url: str) -> None:
    host = (urlparse(url).hostname or "").lower()
    if host not in ALLOWED_HOSTS:
        raise MediaError("URL_NOT_SUPPORTED", "Automatic transcription supports YouTube, Instagram and X links.")
    try:
        assert_public_http_url(url)
    except UnsafeUrlError as exc:
        raise MediaError("URL_REFUSED", str(exc)) from exc


def _classify_download_error(msg: str) -> MediaError:
    m = msg.lower()
    if "no video" in m or "there's no video" in m or "no media" in m or "does not contain" in m:
        return MediaError("NO_MEDIA_IN_POST", "This post has no video or audio to transcribe.")
    if "not a bot" in m or "confirm you" in m:
        return MediaError("BOT_CHECK", "The platform asked the server to prove it is not a bot. Try again later, or import a transcript.", True)
    if "login" in m or "private" in m or "sign in" in m or "age" in m and "confirm" in m:
        return MediaError("LOGIN_REQUIRED", "The platform requires a login for this post. Qivra only transcribes public posts.")
    if "not available" in m or "removed" in m or "404" in m or "unavailable" in m:
        return MediaError("UNAVAILABLE", "This post is unavailable or was removed.")
    if "rate" in m and "limit" in m or "429" in m:
        return MediaError("RATE_LIMITED", "The platform is rate-limiting downloads. Qivra will retry later.", True)
    return MediaError("DOWNLOAD_FAILED", "Could not download the audio for this post.", True)


class _QuietLogger:
    """yt-dlp errors are reported through MediaError codes, not printed to the server console."""

    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def download_audio(url: str, workdir: Path) -> tuple[Path, dict]:
    try:
        import yt_dlp
    except ImportError as exc:
        raise MediaError("DOWNLOADER_MISSING", "Install yt-dlp on the server: pip install -r requirements-media.txt") from exc

    def too_long(info, *, incomplete=False):
        d = info.get("duration")
        if d and d > MAX_SECONDS:
            return f"Video is longer than {MAX_SECONDS // 60} minutes"
        return None

    opts = {
        "format": "bestaudio/best[acodec!=none]/best",
        "outtmpl": str(workdir / "media.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "max_filesize": MAX_BYTES,
        "match_filter": too_long,
        "socket_timeout": 30,
        "retries": 2,
        "cachedir": False,
        "logger": _QuietLogger(),
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:  # yt-dlp raises DownloadError with platform messages
        raise _classify_download_error(str(exc)) from exc
    if info is None:
        raise MediaError("UNAVAILABLE", "This post is unavailable.")
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        if not entries:
            raise MediaError("NO_MEDIA_IN_POST", "This post has no video or audio to transcribe.")
        info = entries[0]
    files = [p for p in workdir.iterdir() if p.is_file() and p.name.startswith("media.") and p.suffix != ".part"]
    if not files:
        if info.get("duration") and info["duration"] > MAX_SECONDS:
            raise MediaError("TOO_LONG", f"Video is longer than {MAX_SECONDS // 60} minutes.")
        raise MediaError("NO_MEDIA_IN_POST", "No downloadable audio was found in this post.")
    meta = {
        "title": (info.get("title") or "")[:300],
        "uploader": (info.get("uploader") or info.get("channel") or "")[:120],
        "description": (info.get("description") or "")[:5000],
        "thumbnail": info.get("thumbnail") or "",
        "duration": info.get("duration"),
        "platform": info.get("extractor_key") or "",
    }
    return files[0], meta


def transcribe_file(path: Path) -> tuple[list[dict], str, str]:
    """Delegate to the configured engine (transcribe-anything / faster-whisper / SuperBrain)."""
    from .transcribers import TranscriberError
    from .transcribers import transcribe_file as run
    try:
        return run(path)
    except TranscriberError as exc:
        raise MediaError(exc.code, exc.message, exc.retryable) from exc


def transcribe_url(url: str, data_dir: Path) -> dict:
    check_url(url)
    tmp_root = data_dir / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="media_", dir=tmp_root))
    try:
        path, meta = download_audio(url, workdir)
        try:
            segments, language, provider = transcribe_file(path)
        except MediaError as exc:
            exc.meta = meta  # type: ignore[attr-defined]  # post details are still useful
            raise
        if not segments:
            err = MediaError("NO_SPEECH", "No speech was detected (the audio may be music only).")
            err.meta = meta  # type: ignore[attr-defined]
            raise err
        return {"segments": segments, "language": language, "provider": provider, "meta": meta}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def clean_caption(text: str) -> str:
    """Instagram/X captions: drop hashtag walls but keep the words."""
    return re.sub(r"(#\w+\s*){4,}$", "", text or "").strip()
