"""Transcription engine registry (Groq / transcribe-anything / faster-whisper / SuperBrain)."""

import json
import os
import sys
import types
from pathlib import Path

import pytest

from qivra import transcribers
from qivra.transcribers import TranscriberError, selected_engine, transcribe_file
from tests.helpers import auth

SRT = "1\n00:00:00,500 --> 00:00:02,000\nHello from a voice note.\n\n2\n00:00:02,100 --> 00:00:04,000\nRemember the hooks idea.\n"


@pytest.fixture
def fake_ta(monkeypatch):
    """Stand-in for transcribe_anything: writes out.srt/out.json exactly like the real package."""
    calls = {}
    mod = types.ModuleType("transcribe_anything")

    def transcribe(url_or_file, output_dir, model, device, **kw):
        calls.update(file=url_or_file, model=model, device=device)
        Path(output_dir, "out.srt").write_text(SRT, encoding="utf-8")
        Path(output_dir, "out.json").write_text(json.dumps({"language": "en"}), encoding="utf-8")
        return output_dir

    mod.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "transcribe_anything", mod)
    monkeypatch.setattr(transcribers, "available_engines", lambda: ["transcribe-anything", "faster-whisper", "superbrain"])
    return calls


def test_auto_prefers_transcribe_anything_on_apple_silicon(monkeypatch, fake_ta):
    monkeypatch.delenv("QIVRA_TRANSCRIBER", raising=False)
    monkeypatch.setattr(transcribers, "apple_silicon", lambda: True)
    assert selected_engine() == "transcribe-anything"
    monkeypatch.setattr(transcribers, "apple_silicon", lambda: False)
    monkeypatch.delenv("QIVRA_TA_DEVICE", raising=False)
    assert selected_engine() == "faster-whisper"
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "transcribe-anything")
    assert selected_engine() == "transcribe-anything"


def test_explicit_engine_must_be_installed(monkeypatch):
    monkeypatch.setattr(transcribers, "available_engines", lambda: ["superbrain"])
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "faster-whisper")
    with pytest.raises(TranscriberError) as e:
        selected_engine()
    assert e.value.code == "TRANSCRIBER_UNAVAILABLE"


def test_transcribe_anything_adapter_parses_srt_and_language(monkeypatch, tmp_path, fake_ta):
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "transcribe-anything")
    monkeypatch.setattr(transcribers, "apple_silicon", lambda: True)
    audio = tmp_path / "note.wav"
    audio.write_bytes(b"RIFF....WAVE")
    segs, lang, provider = transcribe_file(audio)
    assert segs == [{"start_ms": 500, "end_ms": 2000, "text": "Hello from a voice note."},
                    {"start_ms": 2100, "end_ms": 4000, "text": "Remember the hooks idea."}]
    assert lang == "en" and provider == "transcribe-anything-mlx-base"
    assert fake_ta["device"] == "mlx" and fake_ta["file"] == str(audio)


def test_uploaded_recording_job_uses_the_registry(env, monkeypatch, fake_ta):
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "transcribe-anything")
    token, _ = env.pair()
    h = auth(token)
    env.phone.post("/api/v1/items", headers=h, json={"id": "vn1", "data": {"sourceType": "note", "title": "Voice note"}})
    assert env.phone.post("/api/v1/items/vn1/media", headers=h, files={"file": ("note.wav", b"RIFF0000WAVEdata", "audio/wav")}).status_code == 200
    job = env.phone.post("/api/v1/items/vn1/process", headers=h, json={"kind": "transcribe"}).json()["job"]
    env.services.jobs.run_once()
    done = env.services.store.get_job(job["id"])
    assert done["status"] == "succeeded" and done["result"]["provider"].startswith("transcribe-anything")
    tr = env.services.store.list_transcripts("vn1")[0]
    assert tr["segments"][1]["start_ms"] == 2100


def test_pairing_status_reports_engine(env, monkeypatch, fake_ta):
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "transcribe-anything")
    token, _ = env.pair()
    t = env.phone.get("/api/v1/pairing/status", headers=auth(token)).json()["transcription"]
    assert t["engine"] == "transcribe-anything" and "available" in t


def test_python_api_finds_tools_without_activating_venv(monkeypatch, tmp_path, fake_ta):
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "transcribe-anything")
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setattr(transcribers.sysconfig, "get_path", lambda name: "/app/.venv/bin")
    transcribe_file(tmp_path / "note.wav")
    assert os.environ["PATH"].split(os.pathsep)[0] == "/app/.venv/bin"
    assert "/usr/bin" in os.environ["PATH"].split(os.pathsep)


@pytest.mark.parametrize("wanted", ["auto", "transcribe-anything"])
def test_runtime_fallback_is_local_and_only_in_auto_mode(monkeypatch, tmp_path, wanted):
    monkeypatch.setenv("QIVRA_TRANSCRIBER", wanted)
    monkeypatch.setattr(transcribers, "available_engines", lambda: ["transcribe-anything", "faster-whisper", "superbrain"])
    monkeypatch.setattr(transcribers, "apple_silicon", lambda: True)
    calls = []
    def broken_ta(path):
        raise TranscriberError("TRANSCRIPTION_FAILED", "Isolated runtime setup failed", True)
    def local_fw(path):
        calls.append("local")
        return [{"text": "A real transcript", "start_ms": 0, "end_ms": 1000}], "en", "faster-whisper-base"
    def cloud(path):
        pytest.fail("Local fallback must never switch to a possibly cloud-backed engine")
    monkeypatch.setattr(transcribers, "ENGINES", {"transcribe-anything": broken_ta, "faster-whisper": local_fw, "superbrain": cloud})
    if wanted == "auto":
        assert transcribe_file(tmp_path / "note.wav")[2] == "faster-whisper-base"
        assert calls == ["local"]
    else:
        with pytest.raises(TranscriberError):
            transcribe_file(tmp_path / "note.wav")
        assert calls == []


# ── Groq Whisper (cloud first, local fallback) ────────────────────────────────
SECRET = "gsk_test_secret_never_logged"
GROQ_BODY = {"language": "English", "text": " Hello there. Second line.",
             "segments": [{"start": 0.0, "end": 1.52, "text": " Hello there."},
                          {"start": 1.52, "end": 3.0, "text": " Second line."},
                          {"start": 3.0, "end": 3.4, "text": "  "}]}


class FakeResponse:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


@pytest.fixture
def groq(monkeypatch):
    """Gateway pointed at Groq, with httpx.post replaced; returns the list of captured requests."""
    import httpx

    monkeypatch.setenv("QIVRA_AI_BASE_URL", "https://api.groq.com/openai/v1")
    monkeypatch.setenv("QIVRA_AI_API_KEY", SECRET)
    monkeypatch.setenv("QIVRA_AI_MODEL", "openai/gpt-oss-120b")
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "groq")
    monkeypatch.delenv("QIVRA_GROQ_WHISPER_MODEL", raising=False)
    state = {"calls": [], "reply": FakeResponse(200, GROQ_BODY)}

    def post(url, headers=None, files=None, data=None, timeout=None, **kw):
        name, fh, _ = files["file"]
        state["calls"].append({"url": url, "headers": headers, "data": data, "name": name, "type": files["file"][2], "bytes": fh.read()})
        if isinstance(state["reply"], Exception):
            raise state["reply"]
        return state["reply"]

    monkeypatch.setattr(httpx, "post", post)
    return state


@pytest.fixture
def local_fw(monkeypatch):
    calls = []

    def fw(path):
        calls.append("faster-whisper")
        return [{"text": "Local transcript", "start_ms": 0, "end_ms": 900}], "en", "faster-whisper-base"

    def ta(path):
        calls.append("transcribe-anything")
        raise TranscriberError("TRANSCRIPTION_FAILED", "TA runtime broken", True)

    def cloud(path):
        pytest.fail("Groq fallback must stay local")

    monkeypatch.setattr(transcribers, "ENGINES", {"groq": transcribers._groq_transcribe, "transcribe-anything": ta,
                                                  "faster-whisper": fw, "superbrain": cloud})
    monkeypatch.setattr(transcribers, "available_engines",
                        lambda: ["groq", "transcribe-anything", "faster-whisper", "superbrain"])
    return calls


def test_groq_parses_verbose_json(groq, tmp_path):
    audio = tmp_path / "reel.m4a"
    audio.write_bytes(b"audio-bytes")
    segs, lang, provider = transcribe_file(audio)
    assert segs == [{"start_ms": 0, "end_ms": 1520, "text": "Hello there."},
                    {"start_ms": 1520, "end_ms": 3000, "text": "Second line."}]
    assert lang == "en" and provider == "groq-whisper-large-v3-turbo"
    call = groq["calls"][0]
    assert call["url"] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert call["headers"]["Authorization"] == f"Bearer {SECRET}"
    assert call["data"]["model"] == "whisper-large-v3-turbo" and call["data"]["response_format"] == "verbose_json"
    assert call["bytes"] == b"audio-bytes"


def test_groq_uploads_real_media_as_16k_mono_flac(groq, tmp_path):
    """X serves fragmented MP4 audio that Groq rejects; uploads are re-encoded to FLAC first."""
    av = pytest.importorskip("av")
    src = tmp_path / "media.mp4"
    with av.open(str(src), "w", format="mp4") as out:
        st = out.add_stream("aac", rate=44100, layout="stereo")
        for i in range(20):
            frame = av.AudioFrame(format="fltp", layout="stereo", samples=1024)
            for p in frame.planes:
                p.update(bytes(4 * 1024))
            frame.rate = 44100
            frame.pts = i * 1024
            for pkt in st.encode(frame):
                out.mux(pkt)
        for pkt in st.encode(None):
            out.mux(pkt)
    transcribe_file(src)
    call = groq["calls"][0]
    assert call["name"] == "audio.flac" and call["type"] == "audio/flac" and call["bytes"][:4] == b"fLaC"
    assert len(groq["calls"]) == 1


def test_groq_model_override_and_language_codes(groq, monkeypatch, tmp_path):
    monkeypatch.setenv("QIVRA_GROQ_WHISPER_MODEL", "whisper-large-v3")
    groq["reply"] = FakeResponse(200, {"language": "kannada", "text": "ನಮಸ್ಕಾರ", "segments": []})
    (tmp_path / "a.wav").write_bytes(b"x")
    segs, lang, provider = transcribe_file(tmp_path / "a.wav")
    assert segs == [{"start_ms": None, "end_ms": None, "text": "ನಮಸ್ಕಾರ"}]
    assert lang == "kn" and provider == "groq-whisper-large-v3"
    assert transcribers._language_code("en") == "en" and transcribers._language_code("Klingon") == "und"


def test_groq_needs_groq_gateway(monkeypatch):
    monkeypatch.setenv("QIVRA_AI_BASE_URL", "https://api.mistral.ai/v1")
    monkeypatch.setenv("QIVRA_AI_API_KEY", SECRET)
    monkeypatch.setenv("QIVRA_AI_MODEL", "m")
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "groq")
    assert "groq" not in transcribers.available_engines()
    with pytest.raises(TranscriberError) as e:
        selected_engine()
    assert e.value.code == "TRANSCRIBER_UNAVAILABLE"


def test_auto_mode_never_picks_groq(groq, monkeypatch):
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "auto")
    assert "groq" in transcribers.available_engines()
    assert selected_engine() != "groq"


def test_groq_describe_and_banner(groq, monkeypatch):
    monkeypatch.setattr(transcribers, "available_engines", lambda: ["groq", "faster-whisper", "superbrain"])
    info = transcribers.describe()
    assert info["engine"] == "groq" and info["cloud"] is True and info["fallback"] == ["faster-whisper"]
    assert SECRET not in json.dumps(info)
    line = transcribers.banner()
    assert "Groq whisper-large-v3-turbo" in line and "sent to Groq" in line and "faster-whisper" in line


@pytest.mark.parametrize("failure", ["429", "500", "401", "network", "bad-json"])
def test_groq_failure_falls_back_to_local(groq, local_fw, tmp_path, failure, caplog):
    import httpx

    groq["reply"] = {"429": FakeResponse(429), "500": FakeResponse(503), "401": FakeResponse(401),
                     "network": httpx.ConnectError(f"boom Bearer {SECRET}"), "bad-json": FakeResponse(200)}[failure]
    (tmp_path / "a.wav").write_bytes(b"x")
    with caplog.at_level("DEBUG"):
        segs, lang, provider = transcribe_file(tmp_path / "a.wav")
    assert provider == "faster-whisper-base" and local_fw == ["transcribe-anything", "faster-whisper"]
    assert SECRET not in caplog.text and "falling back to local" in caplog.text


def test_groq_oversize_file_skips_upload(groq, local_fw, monkeypatch, tmp_path):
    monkeypatch.setattr(transcribers, "GROQ_MAX_BYTES", 4)
    (tmp_path / "big.wav").write_bytes(b"0123456789")
    assert transcribe_file(tmp_path / "big.wav")[2] == "faster-whisper-base"
    assert groq["calls"] == []


def test_groq_fallback_raises_last_local_error(groq, monkeypatch, tmp_path):
    groq["reply"] = FakeResponse(429)
    monkeypatch.setattr(transcribers, "available_engines", lambda: ["groq", "superbrain"])
    monkeypatch.setattr(transcribers, "ENGINES", {"groq": transcribers._groq_transcribe,
                                                  "superbrain": lambda p: pytest.fail("no cloud fallback")})
    (tmp_path / "a.wav").write_bytes(b"x")
    with pytest.raises(TranscriberError) as e:
        transcribe_file(tmp_path / "a.wav")
    assert e.value.code == "GROQ_RATE_LIMITED" and e.value.retryable


@pytest.mark.skipif(os.getenv("QIVRA_LIVE") != "1", reason="set QIVRA_LIVE=1 to call Groq for real")
def test_live_groq_transcribes_generated_wav(monkeypatch, tmp_path):
    """Speaks a sentence with macOS `say` (or a tone elsewhere) and sends it to Groq using server/qivra.env."""
    import shutil
    import subprocess
    import wave

    from qivra import ai_gateway

    ai_gateway.load_env_file(Path(__file__).resolve().parent.parent / ai_gateway.ENV_FILE_NAME)
    monkeypatch.setenv("QIVRA_TRANSCRIBER", "groq")
    monkeypatch.setattr(transcribers, "available_engines", lambda: ["groq"])
    audio = tmp_path / "live.wav"
    if shutil.which("say"):
        subprocess.run(["say", "-o", str(audio), "--data-format=LEI16@16000", "Remember to review the hooks idea tomorrow."], check=True)
    else:
        with wave.open(str(audio), "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 16000)
    segs, lang, provider = transcribers.ENGINES["groq"](audio)
    assert provider.startswith("groq-")
    print(f"live groq: {lang} {provider} {segs}")
