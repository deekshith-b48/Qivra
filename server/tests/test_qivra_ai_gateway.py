"""Server AI gateway: the owner's provider key is used by the server and never reaches phones."""

import json
import logging

import httpx
import pytest

from qivra import ai, ai_gateway
from tests.helpers import auth

KEY = "gsk_test_secret_key_value"


class FakeResponse:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setenv("QIVRA_AI_BASE_URL", "https://api.groq.com/openai/v1/")
    monkeypatch.setenv("QIVRA_AI_API_KEY", KEY)
    monkeypatch.setenv("QIVRA_AI_MODEL", "openai/gpt-oss-120b")
    monkeypatch.delenv("QIVRA_AI_EMBEDDING_MODEL", raising=False)
    calls = []
    state = {"status": 200, "body": {"model": "openai/gpt-oss-120b",
                                      "choices": [{"message": {"role": "assistant", "content": "Hi [S1]"}}],
                                      "usage": {"prompt_tokens": 5, "completion_tokens": 2}}}

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers})
        return FakeResponse(state["status"], state["body"])

    monkeypatch.setattr(httpx, "post", fake_post)
    return {"calls": calls, "state": state}


def test_phone_chats_through_server_and_never_sees_the_key(env, gateway, caplog):
    caplog.set_level(logging.DEBUG)
    token, _ = env.pair()
    status = env.phone.get("/api/v1/pairing/status", headers=auth(token)).json()
    assert status["ai_gateway"] == {"enabled": True, "upstream": "api.groq.com", "model": "openai/gpt-oss-120b",
                                    "embedding_model": None, "external": True}
    r = env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={
        "model": "something-else", "messages": [{"role": "user", "content": "hello"}],
        "max_tokens": 99999, "temperature": 0.1, "user": "drop-me"})
    assert r.status_code == 200 and r.json()["choices"][0]["message"]["content"] == "Hi [S1]"
    sent = gateway["calls"][0]
    assert sent["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert sent["headers"]["Authorization"] == f"Bearer {KEY}"
    assert sent["json"]["model"] == "openai/gpt-oss-120b"          # model forced by the server
    assert sent["json"]["max_tokens"] == ai_gateway.MAX_TOKENS_CAP  # clamped
    assert "user" not in sent["json"]                              # only allow-listed fields
    everything_the_phone_saw = json.dumps(status) + r.text + env.phone.get("/api/health").text
    assert KEY not in everything_the_phone_saw
    assert KEY not in caplog.text


def test_gateway_requires_a_paired_device(env, gateway):
    r = env.phone.post("/api/v1/ai/chat/completions", json={"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 401 and gateway["calls"] == []


@pytest.mark.parametrize("upstream,status,code", [(401, 401, "AI_KEY_REJECTED"), (429, 429, "AI_RATE_LIMITED"),
                                                  (404, 502, "AI_MODEL_NOT_FOUND"), (500, 502, "AI_PROVIDER_ERROR")])
def test_upstream_errors_are_mapped_without_relaying_the_body(env, gateway, upstream, status, code):
    gateway["state"].update(status=upstream, body={"error": {"message": "secret upstream detail"}})
    token, _ = env.pair()
    r = env.phone.post("/api/v1/ai/chat/completions", headers=auth(token),
                       json={"messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == status and r.json()["error"]["code"] == code
    assert "secret upstream detail" not in r.text


def test_embeddings_need_an_embedding_model(env, gateway, monkeypatch):
    token, _ = env.pair()
    r = env.phone.post("/api/v1/ai/embeddings", headers=auth(token), json={"input": ["a"]})
    assert r.status_code == 503
    monkeypatch.setenv("QIVRA_AI_EMBEDDING_MODEL", "mistral-embed")
    gateway["state"]["body"] = {"data": [{"embedding": [0.1, 0.2], "index": 0}]}
    r = env.phone.post("/api/v1/ai/embeddings", headers=auth(token), json={"input": ["a"], "model": "x"})
    assert r.status_code == 200 and gateway["calls"][-1]["json"] == {"model": "mistral-embed", "input": ["a"]}


def test_not_configured_and_cleartext_internet_refused(env, monkeypatch):
    for k in ("QIVRA_AI_BASE_URL", "QIVRA_AI_API_KEY", "QIVRA_AI_MODEL"):
        monkeypatch.delenv(k, raising=False)
    token, _ = env.pair()
    assert env.phone.get("/api/v1/pairing/status", headers=auth(token)).json()["ai_gateway"] == {"enabled": False}
    assert env.phone.post("/api/v1/ai/chat/completions", headers=auth(token),
                          json={"messages": [{"role": "user", "content": "x"}]}).status_code == 503
    monkeypatch.setenv("QIVRA_AI_BASE_URL", "http://api.example.com/v1")
    monkeypatch.setenv("QIVRA_AI_MODEL", "m")
    assert ai_gateway.config() is None  # a key must not travel over HTTP to the internet
    monkeypatch.setenv("QIVRA_AI_BASE_URL", "http://192.168.1.10:11434/v1")
    assert ai_gateway.describe()["external"] is False


def test_server_jobs_use_the_gateway(gateway):
    text, provider = ai.generate("Summarise")
    assert text == "Hi [S1]" and provider == "server:api.groq.com:openai/gpt-oss-120b"


def test_env_file_loading_keeps_real_env_and_ignores_other_keys(tmp_path, monkeypatch):
    for k in ("QIVRA_AI_BASE_URL", "QIVRA_AI_API_KEY", "QIVRA_AI_MODEL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("QIVRA_AI_MODEL", "from-env")
    f = tmp_path / "qivra.env"
    f.write_text("# comment\nQIVRA_AI_BASE_URL='https://api.groq.com/openai/v1'\nQIVRA_AI_MODEL=from-file\n"
                 "QIVRA_AI_API_KEY=k\nPATH=/evil\n", encoding="utf-8")
    loaded = ai_gateway.load_env_file(f)
    assert sorted(loaded) == ["QIVRA_AI_API_KEY", "QIVRA_AI_BASE_URL"]
    assert ai_gateway.config()["model"] == "from-env" and ai_gateway.config()["base_url"].startswith("https://")
    assert "/evil" not in __import__("os").environ["PATH"]
    assert ai_gateway.load_env_file(tmp_path / "missing.env") == []
