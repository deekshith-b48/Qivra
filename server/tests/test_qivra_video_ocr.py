"""On-screen text for reels without speech (video_ocr.py + the transcribe_url fallback)."""

import os
from pathlib import Path

import pytest

from qivra import media, video_ocr
from qivra.media import MediaError
from qivra.video_ocr import dedupe_frame_texts
from tests.helpers import auth

LIVE = os.getenv("QIVRA_LIVE") == "1"
HAS_RAPIDOCR = video_ocr.available()


def test_repeated_frame_text_is_merged_with_first_appearance_as_start():
    frames = [
        (0, ["@coach.dev", "3 SQL tips"]),
        (2000, ["@coach.dev", "3 SQL tips"]),
        (4000, ["@coach.dev", "1. Index your foreign keys"]),
        (6000, ["@coach.dev", "1. Index your foreign keys"]),
        (8000, ["@coach.dev"]),  # only the watermark: nothing new
        (10000, ["@coach.dev", "2. Avoid SELECT *"]),
    ]
    assert dedupe_frame_texts(frames, 2000) == [
        {"start_ms": 0, "end_ms": 4000, "text": "@coach.dev 3 SQL tips"},
        {"start_ms": 4000, "end_ms": 8000, "text": "1. Index your foreign keys"},
        {"start_ms": 10000, "end_ms": 12000, "text": "2. Avoid SELECT *"},
    ]


def test_ocr_jitter_and_typing_captions_count_as_the_same_text():
    frames = [
        (6000, ["Stop scrolling and"]),
        (0, []),
        (2000, ["Stop scrolling"]),
        (4000, ["Stop scroling and"]),  # OCR noise
        (8000, ["Stop scrolling and read this"]),
        (10000, ["|", "--"]),  # no letters or digits
    ]
    assert dedupe_frame_texts(frames, 2000) == [{"start_ms": 2000, "end_ms": 10000, "text": "Stop scrolling and read this"}]
    # A different caption is a new segment even when it shares a word.
    out = dedupe_frame_texts([(0, ["Stop scrolling"]), (2000, ["Start building"])], 2000)
    assert [s["start_ms"] for s in out] == [0, 2000]


def test_a_caption_on_most_frames_keeps_its_own_time():
    frames = [(0, ["Intro"])] + [(ms, ["Big idea here"]) for ms in range(2000, 12000, 2000)]
    assert dedupe_frame_texts(frames, 2000) == [
        {"start_ms": 0, "end_ms": 2000, "text": "Intro"},
        {"start_ms": 2000, "end_ms": 12000, "text": "Big idea here"},
    ]
    only = [(ms, ["Same caption"]) for ms in (4000, 6000, 8000)]
    assert dedupe_frame_texts(only, 2000) == [{"start_ms": 4000, "end_ms": 10000, "text": "Same caption"}]


def test_no_text_gives_no_segments():
    assert dedupe_frame_texts([], 2000) == []
    assert dedupe_frame_texts([(0, []), (2000, [" "])], 2000) == []


def _fake_download(name):
    def dl(url, workdir: Path):
        p = workdir / name
        p.write_bytes(b"x")
        return p, {"title": "Reel", "uploader": "u", "description": "", "thumbnail": "", "duration": 9, "platform": "Instagram"}
    return dl


def _no_speech(path):
    raise MediaError("NO_SPEECH", "No speech was detected (the audio may be music only).")


def test_no_speech_falls_back_to_on_screen_text(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(media, "download_audio", _fake_download("media.m4a"))
    monkeypatch.setattr(media, "download_video", lambda url, wd: calls.append(url) or _fake_download("video.mp4")(url, wd))
    monkeypatch.setattr(media, "transcribe_file", _no_speech)
    monkeypatch.setattr(video_ocr, "load_recognizer", lambda: (lambda img: []))
    segs = [{"start_ms": 2000, "end_ms": 4000, "text": "Index your foreign keys"}]
    monkeypatch.setattr(video_ocr, "ocr_video", lambda path, *a, **k: segs if path.name == "video.mp4" else [])
    out = media.transcribe_url("https://www.instagram.com/reel/CDUMkliABpa/", tmp_path)
    assert out["segments"] == [] and out["ocr_segments"] == segs and out["meta"]["title"] == "Reel"
    assert calls == ["https://www.instagram.com/reel/CDUMkliABpa/"]
    assert not any((tmp_path / "tmp").iterdir())  # temp video deleted


def test_short_transcript_also_gets_on_screen_text_but_long_one_does_not(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "download_audio", _fake_download("media.m4a"))
    monkeypatch.setattr(media, "download_video", _fake_download("video.mp4"))
    monkeypatch.setattr(video_ocr, "load_recognizer", lambda: (lambda img: []))
    monkeypatch.setattr(video_ocr, "ocr_video", lambda path, *a, **k: [{"start_ms": 0, "end_ms": 2000, "text": "Read the caption"}])
    monkeypatch.setattr(media, "transcribe_file", lambda p: ([{"start_ms": 0, "end_ms": 900, "text": "Wow."}], "en", "fw"))
    out = media.transcribe_url("https://x.com/a/status/12345", tmp_path)
    assert out["segments"][0]["text"] == "Wow." and out["ocr_segments"][0]["text"] == "Read the caption"
    long = [{"start_ms": 0, "end_ms": 9000, "text": "Today we look at how React hooks keep state between renders."}]
    monkeypatch.setattr(media, "transcribe_file", lambda p: (long, "en", "fw"))
    assert media.transcribe_url("https://x.com/a/status/12345", tmp_path)["ocr_segments"] == []


def test_without_rapidocr_no_speech_fails_exactly_as_before(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "download_audio", _fake_download("media.m4a"))
    monkeypatch.setattr(media, "download_video", lambda *a: pytest.fail("must not download video without OCR"))
    monkeypatch.setattr(media, "transcribe_file", _no_speech)
    monkeypatch.setattr(video_ocr, "load_recognizer", lambda: None)
    with pytest.raises(MediaError) as e:
        media.transcribe_url("https://www.instagram.com/reel/CDUMkliABpa/", tmp_path)
    assert e.value.code == "NO_SPEECH" and e.value.meta["title"] == "Reel"
    assert not any((tmp_path / "tmp").iterdir())


def test_unreadable_video_keeps_the_speech_error(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "download_audio", _fake_download("media.m4a"))
    monkeypatch.setattr(media, "transcribe_file", lambda p: (_ for _ in ()).throw(MediaError("NO_AUDIO", "This file has no audio track.")))
    monkeypatch.setattr(video_ocr, "load_recognizer", lambda: (lambda img: []))

    def login(url, wd):
        raise MediaError("LOGIN_REQUIRED", "login")
    monkeypatch.setattr(media, "download_video", login)
    with pytest.raises(MediaError) as e:
        media.transcribe_url("https://www.instagram.com/reel/CDUMkliABpa/", tmp_path)
    assert e.value.code == "NO_AUDIO"


def test_job_stores_on_screen_text_as_timestamped_video_ocr_transcript(env, monkeypatch):
    token, _ = env.pair()
    h = auth(token)
    env.phone.post("/api/v1/items", headers=h, json={"id": "reel2", "data": {"sourceType": "instagram",
                   "url": "https://www.instagram.com/reel/Chunk8-jurw/", "title": ""}})
    ocr = [{"start_ms": 0, "end_ms": 4000, "text": "3 SQL tips"}, {"start_ms": 4000, "end_ms": 8000, "text": "Index your foreign keys"}]
    monkeypatch.setattr(media, "transcribe_url", lambda url, d: {
        "segments": [], "language": "und", "provider": "", "ocr_segments": ocr,
        "meta": {"title": "SQL", "uploader": "coach", "description": "", "thumbnail": "", "duration": 9, "platform": "Instagram"}})
    job = env.phone.post("/api/v1/items/reel2/process", headers=h, json={"kind": "transcribe_url"}).json()["job"]
    assert env.services.jobs.run_once()
    done = env.services.store.get_job(job["id"])
    assert done["status"] == "succeeded" and done["result"]["ocr_segments"] == 2
    [tr] = env.phone.get("/api/v1/items/reel2/transcripts", headers=h).json()["transcripts"]
    assert tr["source"] == "video_ocr" and tr["provider"] == "rapidocr"
    assert [s["start_ms"] for s in tr["segments"]] == [0, 4000]
    assert "Index your foreign keys" in tr["text"]


def _write_video(path: Path, colors: list[tuple[int, int, int]], seconds_each: int = 2, fps: int = 5, draw=None):
    av = pytest.importorskip("av")
    np = pytest.importorskip("numpy")
    with av.open(str(path), "w") as out:
        st = out.add_stream("mpeg4", rate=fps)
        st.width, st.height, st.pix_fmt = 320, 240, "yuv420p"
        for i, color in enumerate(colors):
            img = np.zeros((240, 320, 3), dtype=np.uint8)
            img[:] = color
            if draw:
                img = draw(img, i)
            for _ in range(seconds_each * fps):
                for pkt in st.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                    out.mux(pkt)
        for pkt in st.encode():
            out.mux(pkt)


def test_frames_are_sampled_every_two_seconds_and_mapped_to_their_time(tmp_path):
    video = tmp_path / "v.mp4"
    _write_video(video, [(250, 0, 0), (250, 0, 0), (0, 250, 0), (0, 0, 250)])  # 8 s: red, red, green, blue

    def recognize(img):
        r, g, b = (int(x) for x in img.reshape(-1, 3).mean(axis=0))
        return ["Red slide"] if r > 200 else ["Green slide"] if g > 200 else ["Blue slide"]

    assert [ms for ms, _ in video_ocr.sample_frames(video, 2.0)] == [0, 2000, 4000, 6000]
    assert video_ocr.ocr_video(video, recognize, 2.0) == [
        {"start_ms": 0, "end_ms": 4000, "text": "Red slide"},
        {"start_ms": 4000, "end_ms": 6000, "text": "Green slide"},
        {"start_ms": 6000, "end_ms": 8000, "text": "Blue slide"},
    ]


def _text_image(text: str, size=(640, 200), font_size=48):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", size, "white")
    ImageDraw.Draw(img).text((16, size[1] // 3), text, fill="black", font=ImageFont.load_default(size=font_size))
    return img


@pytest.mark.skipif(not (LIVE and HAS_RAPIDOCR), reason="set QIVRA_LIVE=1 with requirements-ocr.txt installed")
def test_live_rapidocr_reads_a_generated_image():
    import numpy as np
    lines = video_ocr.load_recognizer()(np.array(_text_image("Qivra reads this")))
    text = " ".join(lines).lower()
    assert "qivra" in text and "reads this" in text


@pytest.mark.skipif(not (LIVE and HAS_RAPIDOCR), reason="set QIVRA_LIVE=1 with requirements-ocr.txt installed")
def test_live_rapidocr_on_a_generated_video(tmp_path):
    import numpy as np
    texts = ["Index foreign keys", "Index foreign keys", "Avoid SELECT star"]
    video = tmp_path / "t.mp4"
    _write_video(video, [(255, 255, 255)] * 3, draw=lambda img, i: np.array(_text_image(texts[i], (320, 240), 26)))
    out = video_ocr.ocr_video(video)
    assert len(out) == 2 and out[1]["start_ms"] == 4000
    assert "foreign" in out[0]["text"].lower() and "select" in out[1]["text"].lower()
