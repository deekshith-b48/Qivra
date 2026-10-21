"""Transcription engine registry (transcribe-anything / faster-whisper / SuperBrain)."""

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
