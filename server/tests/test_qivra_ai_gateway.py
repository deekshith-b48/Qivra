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


# ── streaming ─────────────────────────────────────────────────────────────────
class FakeStream:
    def __init__(self, status, chunks=(), fail_after=None):
        self.status_code = status
        self._chunks = list(chunks)
        self._fail_after = fail_after
        self.closed = False

    def iter_bytes(self):
        for i, ch in enumerate(self._chunks):
            if self._fail_after is not None and i == self._fail_after:
                raise httpx.ReadError("boom")
            yield ch

    def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, stream):
        self.stream = stream
        self.sent = None
        self.closed = False

    def build_request(self, method, url, json=None, headers=None):
        return {"method": method, "url": url, "json": json, "headers": headers}

    def send(self, req, stream=False):
        self.sent = req
        assert stream is True
        return self.stream

    def close(self):
        self.closed = True


SSE = [b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', b'data: {"choices":[{"delta":{"content":"lo [S1]"}}]}\n\n', b"data: [DONE]\n\n"]


def test_stream_is_relayed_as_sse_with_model_forced_and_key_hidden(env, gateway, monkeypatch):
    client = FakeClient(FakeStream(200, SSE))
    monkeypatch.setattr(ai_gateway, "_client", lambda: client)
    token, _ = env.pair()
    r = env.phone.post("/api/v1/ai/chat/completions", headers=auth(token),
                       json={"model": "x", "stream": True, "messages": [{"role": "user", "content": "hi"}], "user": "drop"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.text == b"".join(SSE).decode()
    assert client.sent["json"]["stream"] is True and client.sent["json"]["model"] == "openai/gpt-oss-120b"
    assert "user" not in client.sent["json"] and client.sent["headers"]["Authorization"] == f"Bearer {KEY}"
    assert KEY not in r.text and client.closed and client.stream.closed


def test_stream_errors_before_first_byte_are_json(env, gateway, monkeypatch):
    monkeypatch.setattr(ai_gateway, "_client", lambda: FakeClient(FakeStream(429)))
    token, _ = env.pair()
    r = env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={"stream": True, "messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 429 and r.json()["error"]["code"] == "AI_RATE_LIMITED"


def test_stream_interruption_ends_with_an_error_event(env, gateway, monkeypatch):
    client = FakeClient(FakeStream(200, SSE, fail_after=1))
    monkeypatch.setattr(ai_gateway, "_client", lambda: client)
    token, _ = env.pair()
    r = env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={"stream": True, "messages": [{"role": "user", "content": "x"}]})
    assert r.text.startswith(SSE[0].decode()) and "AI_STREAM_INTERRUPTED" in r.text
    assert client.closed


def test_stream_requires_a_paired_device(env, gateway, monkeypatch):
    monkeypatch.setattr(ai_gateway, "_client", lambda: pytest.fail("must not reach the provider"))
    r = env.phone.post("/api/v1/ai/chat/completions", json={"stream": True, "messages": [{"role": "user", "content": "x"}]})
    assert r.status_code == 401


@pytest.mark.skipif(__import__("os").getenv("QIVRA_LIVE") != "1", reason="set QIVRA_LIVE=1 to stream from the real provider")
def test_live_stream_from_provider(monkeypatch):
    from qivra.config import SERVER_DIR
    for k in ("QIVRA_AI_BASE_URL", "QIVRA_AI_API_KEY", "QIVRA_AI_MODEL"):
        monkeypatch.delenv(k, raising=False)
    ai_gateway.load_env_file(SERVER_DIR / ai_gateway.ENV_FILE_NAME)
    chunks = list(ai_gateway.open_chat_stream({"messages": [{"role": "user", "content": "Count from 1 to 5, comma separated."}], "max_tokens": 200}))
    text = b"".join(chunks).decode()
    assert text.count("data:") > 2 and "[DONE]" in text


def test_reasoning_models_default_to_low_effort(env, gateway, monkeypatch):
    token, _ = env.pair()
    env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={"messages": [{"role": "user", "content": "x"}]})
    assert gateway["calls"][-1]["json"]["reasoning_effort"] == "low"  # gpt-oss model in the fixture
    env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={"messages": [{"role": "user", "content": "x"}], "reasoning_effort": "high"})
    assert gateway["calls"][-1]["json"]["reasoning_effort"] == "high"
    env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={"messages": [{"role": "user", "content": "x"}], "reasoning_effort": "max!!"})
    assert gateway["calls"][-1]["json"]["reasoning_effort"] == "low"  # invalid values are replaced
    monkeypatch.setenv("QIVRA_AI_MODEL", "mistral-small-latest")
    env.phone.post("/api/v1/ai/chat/completions", headers=auth(token), json={"messages": [{"role": "user", "content": "x"}]})
    assert "reasoning_effort" not in gateway["calls"][-1]["json"]  # not sent to non-reasoning models
