"""Automatic video transcription job (transcribe_url)."""

import os

import pytest

from qivra import media
from qivra.media import MediaError, _classify_download_error, check_url
from tests.helpers import auth

LIVE = os.getenv("QIVRA_LIVE") == "1"


def test_only_video_platforms_are_accepted():
    for ok in ("https://www.instagram.com/reel/CDUMkliABpa/", "https://x.com/a/status/1", "https://youtu.be/abc"):
        check_url(ok)
    for bad in ("https://example.com/video.mp4", "http://127.0.0.1:5000/x", "file:///etc/passwd", "https://evil.youtube.com.attacker.net/x"):
        with pytest.raises(MediaError):
            check_url(bad)


@pytest.mark.parametrize("msg,code,retry", [
    ("ERROR: [twitter] 1: No video could be found in this tweet", "NO_MEDIA_IN_POST", False),
    ("ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required", "LOGIN_REQUIRED", False),
    ("ERROR: Video unavailable. This video has been removed", "UNAVAILABLE", False),
    ("HTTP Error 429: Too Many Requests", "RATE_LIMITED", True),
    ("ERROR: [youtube] x: Sign in to confirm you’re not a bot", "BOT_CHECK", True),
    ("something odd", "DOWNLOAD_FAILED", True),
])
def test_download_errors_are_classified(msg, code, retry):
    e = _classify_download_error(msg)
    assert (e.code, e.retryable) == (code, retry)


def test_job_stores_timestamped_transcript_and_caption(env, monkeypatch):
    token, _ = env.pair()
    h = auth(token)
    env.phone.post("/api/v1/items", headers=h, json={"id": "reel1", "data": {"sourceType": "instagram",
                   "url": "https://www.instagram.com/reel/CDUMkliABpa/", "title": ""}})
    monkeypatch.setattr(media, "transcribe_url", lambda url, d: {
        "segments": [{"start_ms": 0, "end_ms": 1500, "text": "Hooks run first."}], "language": "en",
        "provider": "faster-whisper-base",
        "meta": {"title": "Reel title", "uploader": "someone", "description": "Great tips #a #b #c #d #e",
                 "thumbnail": "https://cdn/x.jpg", "duration": 12, "platform": "Instagram"}})
    job = env.phone.post("/api/v1/items/reel1/process", headers=h, json={"kind": "transcribe_url"}).json()["job"]
    assert env.services.jobs.run_once()
    done = env.services.store.get_job(job["id"])
    assert done["status"] == "succeeded" and done["result"]["segments"] == 1
    tr = env.phone.get("/api/v1/items/reel1/transcripts", headers=h).json()["transcripts"][0]
    assert tr["segments"][0]["start_ms"] == 0 and tr["provider"] == "faster-whisper-base"
    item = env.phone.get("/api/v1/items/reel1", headers=h).json()["item"]["data"]
    assert item["title"] == "Reel title" and item["metadata"]["description"] == "Great tips"


def test_job_failures_are_honest(env, monkeypatch):
    token, _ = env.pair()
    h = auth(token)
    env.phone.post("/api/v1/items", headers=h, json={"id": "m1", "data": {"url": "https://x.com/a/status/1"}})

    def boom(url, d):
        raise MediaError("NO_SPEECH", "No speech was detected (the audio may be music only).")
    monkeypatch.setattr(media, "transcribe_url", boom)
    job = env.phone.post("/api/v1/items/m1/process", headers=h, json={"kind": "transcribe_url"}).json()["job"]
    env.services.jobs.run_once()
    j = env.services.store.get_job(job["id"])
    assert (j["status"], j["error_code"]) == ("failed_permanent", "NO_SPEECH")
    assert env.services.store.list_transcripts("m1") == []


@pytest.mark.skipif(not LIVE, reason="set QIVRA_LIVE=1 to download and transcribe real public videos")
def test_live_youtube_short_transcription(tmp_path):
    try:
        out = media.transcribe_url("https://www.youtube.com/shorts/BGQWPY4IigY", tmp_path)
        assert out["segments"] and out["segments"][0]["start_ms"] is not None
        assert out["language"] == "en"
    except MediaError as e:  # YouTube may bot-check server downloads; the phone fetches captions instead
        assert e.code == "BOT_CHECK", e.code
    assert not any((tmp_path / "tmp").iterdir())  # temp audio deleted


@pytest.mark.skipif(not LIVE, reason="set QIVRA_LIVE=1 to download and transcribe real public videos")
@pytest.mark.parametrize("url", ["https://www.instagram.com/reel/CDUMkliABpa/", "https://www.instagram.com/reel/Chunk8-jurw/",
                                 "https://twitter.com/captainamerica/status/719944021058060289"])
def test_live_instagram_and_x(tmp_path, url):
    try:
        out = media.transcribe_url(url, tmp_path)
        assert out["segments"] or out.get("ocr_segments")  # music-only reels: on-screen text when RapidOCR is installed
    except MediaError as e:  # music-only or login-gated posts must fail with a clear code
        assert e.code in {"NO_SPEECH", "NO_AUDIO", "LOGIN_REQUIRED", "NO_MEDIA_IN_POST"}, e.code
    assert not any((tmp_path / "tmp").iterdir())
