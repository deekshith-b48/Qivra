"""Local embeddings (fastembed) served through the AI gateway: nothing leaves the machine."""

import pytest

from qivra import ai_gateway, embeddings
from tests.helpers import auth


@pytest.fixture
def gw(monkeypatch):
    monkeypatch.setenv("QIVRA_AI_BASE_URL", "https://api.groq.com/openai/v1")
    monkeypatch.setenv("QIVRA_AI_API_KEY", "k")
    monkeypatch.setenv("QIVRA_AI_MODEL", "openai/gpt-oss-120b")
    monkeypatch.delenv("QIVRA_AI_EMBEDDING_MODEL", raising=False)
    monkeypatch.delenv("QIVRA_LOCAL_EMBEDDINGS", raising=False)
    monkeypatch.setattr(embeddings, "available", lambda: True)
    calls = []
    monkeypatch.setattr(embeddings, "embed", lambda texts: calls.append(texts) or [[1.0, 0.0], [0.0, 1.0]][: len(texts)])
    import httpx
    monkeypatch.setattr(httpx, "post", lambda *a, **k: pytest.fail("local embeddings must not call the provider"))
    return calls


def test_local_embeddings_used_when_no_hosted_model(env, gw):
    token, _ = env.pair()
    st = env.phone.get("/api/v1/pairing/status", headers=auth(token)).json()["ai_gateway"]
    assert st["embedding_model"] == "local:paraphrase-multilingual-MiniLM-L12-v2" and st["embedding_local"] is True
    r = env.phone.post("/api/v1/ai/embeddings", headers=auth(token), json={"input": ["a", "b"], "model": "ignored"})
    assert r.status_code == 200
    assert r.json() == {"object": "list", "model": "local:paraphrase-multilingual-MiniLM-L12-v2",
                        "data": [{"object": "embedding", "index": 0, "embedding": [1.0, 0.0]},
                                 {"object": "embedding", "index": 1, "embedding": [0.0, 1.0]}]}
    assert gw == [["a", "b"]]


def test_hosted_embedding_model_wins_and_switch_off(env, gw, monkeypatch):
    monkeypatch.setenv("QIVRA_AI_EMBEDDING_MODEL", "mistral-embed")
    assert ai_gateway.config()["embedding_local"] is False
    monkeypatch.delenv("QIVRA_AI_EMBEDDING_MODEL")
    monkeypatch.setenv("QIVRA_LOCAL_EMBEDDINGS", "0")
    monkeypatch.setattr(embeddings, "available", lambda: False)
    assert ai_gateway.config()["embedding_model"] is None


def test_local_failure_is_a_clear_503(env, gw, monkeypatch):
    def boom(texts):
        raise OSError("no disk")
    monkeypatch.setattr(embeddings, "embed", boom)
    token, _ = env.pair()
    r = env.phone.post("/api/v1/ai/embeddings", headers=auth(token), json={"input": ["a"]})
    assert r.status_code == 503 and r.json()["error"]["code"] == "EMBEDDINGS_UNAVAILABLE"


@pytest.mark.skipif(__import__("os").getenv("QIVRA_LIVE") != "1" or not embeddings.available(), reason="set QIVRA_LIVE=1 with fastembed installed")
def test_live_multilingual_similarity():
    a, b, c, hi = embeddings.embed(["speeding up postgres queries with indexes", "GIN index for JSONB documents",
                                    "elephants have long trunks", "डेटाबेस क्वेरी को तेज़ कैसे करें"])
    dot = lambda x, y: sum(p * q for p, q in zip(x, y))  # noqa: E731
    assert len(a) == 384 and abs(dot(a, a) - 1) < 1e-3
    assert dot(a, b) > dot(a, c) and dot(a, hi) > dot(a, c)
