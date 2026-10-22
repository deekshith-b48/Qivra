"""Server-side AI gateway: paired phones use the owner's AI provider through the server.

The provider key lives only on this machine (server/qivra.env or the environment):
  QIVRA_AI_BASE_URL         OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1
  QIVRA_AI_API_KEY          provider key (never returned, logged, put in QR codes or synced)
  QIVRA_AI_MODEL            chat model, e.g. openai/gpt-oss-120b
  QIVRA_AI_EMBEDDING_MODEL  optional embedding model (Groq has none; leave empty)

Phones call /api/v1/ai/chat/completions and /api/v1/ai/embeddings with their
device credential. The server forces the configured model, forwards only an
allow-listed set of request fields, and never relays the upstream error body.
"""

from __future__ import annotations

import ipaddress
import logging
import os
from pathlib import Path
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlparse

from . import embeddings as local_embeddings  # (ai_gateway.embeddings() is the API handler below)

logger = logging.getLogger(__name__)

ENV_FILE_NAME = "qivra.env"
_ENV_KEYS = ("QIVRA_AI_BASE_URL", "QIVRA_AI_API_KEY", "QIVRA_AI_MODEL", "QIVRA_AI_EMBEDDING_MODEL",
             "QIVRA_TRANSCRIBER", "QIVRA_GROQ_WHISPER_MODEL")
CHAT_FIELDS = {"messages", "temperature", "max_tokens", "top_p", "stop", "tools", "tool_choice", "response_format", "stream_options",
               "reasoning_effort"}
REASONING_EFFORTS = {"low", "medium", "high"}
MAX_TOKENS_CAP = 4096
MAX_EMBED_INPUTS = 256


class GatewayError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def load_env_file(path: Path) -> list[str]:
    """Read KEY=VALUE lines for the gateway keys. Real environment variables win. Returns keys set."""
    if not path.is_file():
        return []
    loaded = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (p.strip() for p in line.split("=", 1))
        value = value.strip("'\"")
        if key in _ENV_KEYS and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


def _private_host(host: str) -> bool:
    if host in ("localhost",) or host.endswith(".local"):
        return True
    try:
        return ipaddress.ip_address(host).is_private
    except ValueError:
        return False


def config() -> dict | None:
    """The gateway configuration, or None when it is not (validly) configured."""
    base = os.getenv("QIVRA_AI_BASE_URL", "").strip().rstrip("/")
    model = os.getenv("QIVRA_AI_MODEL", "").strip()
    if not base or not model:
        return None
    url = urlparse(base)
    host = url.hostname or ""
    # A key must not travel over cleartext to the internet.
    if url.scheme not in ("http", "https") or not host or (url.scheme == "http" and not _private_host(host)):
        logger.warning("QIVRA_AI_BASE_URL ignored: use https for hosted providers.")
        return None
    upstream_embed = os.getenv("QIVRA_AI_EMBEDDING_MODEL", "").strip() or None
    # No hosted embedding model (Groq has none): use the local one on this machine if installed.
    local_embed = upstream_embed is None and local_embeddings.available()
    return {
        "base_url": base,
        "host": host,
        "model": model,
        "embedding_model": upstream_embed or (local_embeddings.label() if local_embed else None),
        "embedding_local": local_embed,
        "api_key": os.getenv("QIVRA_AI_API_KEY", "").strip() or None,
    }


def describe() -> dict:
    """Public description for paired devices (no key)."""
    cfg = config()
    if cfg is None:
        return {"enabled": False}
    return {"enabled": True, "upstream": cfg["host"], "model": cfg["model"],
            "embedding_model": cfg["embedding_model"], "embedding_local": cfg["embedding_local"],
            "external": not _private_host(cfg["host"])}


def _headers(cfg: dict) -> dict:
    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    return headers


def _status_error(status: int, model: str | None) -> GatewayError:
    """Map an upstream HTTP error to our own error (the upstream body is never relayed)."""
    if status in (401, 403):
        return GatewayError(status, "AI_KEY_REJECTED", "The AI provider rejected the server's API key.")
    if status == 429:
        return GatewayError(429, "AI_RATE_LIMITED", "The AI provider rate limit was reached. Try again shortly.")
    if status == 404:
        return GatewayError(502, "AI_MODEL_NOT_FOUND", f"The AI provider does not offer model '{model}'.")
    logger.warning("AI provider returned HTTP %s", status)
    return GatewayError(502, "AI_PROVIDER_ERROR", f"The AI provider returned HTTP {status}.")


def _post(cfg: dict, path: str, payload: dict, timeout: float) -> dict:
    import httpx

    try:
        res = httpx.post(cfg["base_url"] + path, json=payload, headers=_headers(cfg), timeout=timeout)
    except httpx.TimeoutException as exc:
        raise GatewayError(504, "AI_TIMEOUT", "The AI provider timed out.") from exc
    except httpx.HTTPError as exc:
        raise GatewayError(502, "AI_UNREACHABLE", "The server could not reach the AI provider.") from exc
    if res.status_code >= 400:
        raise _status_error(res.status_code, payload.get("model"))
    try:
        return res.json()
    except ValueError as exc:
        raise GatewayError(502, "AI_BAD_RESPONSE", "The AI provider returned invalid JSON.") from exc


def _chat_payload(body: dict[str, Any]) -> tuple[dict, dict]:
    cfg = config()
    if cfg is None:
        raise GatewayError(503, "AI_NOT_CONFIGURED", "No AI provider is configured on the server.")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise GatewayError(400, "INVALID_REQUEST", "messages must be a non-empty list.")
    payload = {k: v for k, v in body.items() if k in CHAT_FIELDS}
    payload["model"] = cfg["model"]
    try:
        payload["max_tokens"] = max(1, min(int(payload.get("max_tokens") or 1200), MAX_TOKENS_CAP))
    except (TypeError, ValueError):
        payload["max_tokens"] = 1200
    # Reasoning models (gpt-oss) spend output tokens "thinking" before they answer; at the
    # default effort a 900-token budget can end before any answer is written. Low effort keeps
    # answers complete and starts streamed text sooner. QIVRA_AI_REASONING_EFFORT overrides.
    if payload.get("reasoning_effort") not in REASONING_EFFORTS:
        payload.pop("reasoning_effort", None)
        effort = os.getenv("QIVRA_AI_REASONING_EFFORT", "").strip().lower()
        if effort in REASONING_EFFORTS:
            payload["reasoning_effort"] = effort
        elif not effort and "gpt-oss" in cfg["model"]:
            payload["reasoning_effort"] = "low"
    return cfg, payload


def chat(body: dict[str, Any]) -> dict:
    cfg, payload = _chat_payload(body)
    return _post(cfg, "/chat/completions", payload, timeout=120.0)


def _client():
    import httpx

    return httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))


def open_chat_stream(body: dict[str, Any]) -> Iterator[bytes]:
    """Start a streamed chat completion and return an iterator over the upstream SSE bytes.

    Errors before the first byte (unreachable, key rejected, rate limit…) are raised
    as GatewayError so the phone gets a normal JSON error; once streaming has begun,
    an interruption is reported as a final SSE `data:` event.
    """
    import httpx

    cfg, payload = _chat_payload(body)
    payload["stream"] = True
    client = _client()
    try:
        req = client.build_request("POST", cfg["base_url"] + "/chat/completions", json=payload, headers=_headers(cfg))
        res = client.send(req, stream=True)
    except httpx.TimeoutException as exc:
        client.close()
        raise GatewayError(504, "AI_TIMEOUT", "The AI provider timed out.") from exc
    except httpx.HTTPError as exc:
        client.close()
        raise GatewayError(502, "AI_UNREACHABLE", "The server could not reach the AI provider.") from exc
    if res.status_code >= 400:
        res.close()
        client.close()
        raise _status_error(res.status_code, payload.get("model"))

    def relay() -> Iterator[bytes]:
        try:
            yield from res.iter_bytes()
        except httpx.HTTPError:
            logger.warning("AI stream interrupted")
            yield b'data: {"error": {"code": "AI_STREAM_INTERRUPTED", "message": "The AI provider stopped responding."}}\n\n'
        finally:
            res.close()
            client.close()

    return relay()


def embeddings(body: dict[str, Any]) -> dict:
    cfg = config()
    if cfg is None or not cfg["embedding_model"]:
        raise GatewayError(503, "AI_NOT_CONFIGURED", "No embedding model is configured on the server.")
    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [inputs]
    if not isinstance(inputs, list) or not inputs or len(inputs) > MAX_EMBED_INPUTS or not all(isinstance(i, str) for i in inputs):
        raise GatewayError(400, "INVALID_REQUEST", f"input must be 1–{MAX_EMBED_INPUTS} strings.")
    if cfg["embedding_local"]:
        try:
            vectors = local_embeddings.embed(inputs)
        except Exception as exc:  # model download blocked, out of memory…
            logger.warning("Local embeddings failed (%s)", type(exc).__name__)
            raise GatewayError(503, "EMBEDDINGS_UNAVAILABLE", "The server's local embedding model is not available.") from exc
        return {"object": "list", "model": cfg["embedding_model"],
                "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vectors)]}
    return _post(cfg, "/embeddings", {"model": cfg["embedding_model"], "input": inputs}, timeout=60.0)


def generate(prompt: str) -> str:
    """Single-prompt completion for server-side jobs (enrichment, agent, reports)."""
    data = chat({"messages": [{"role": "user", "content": prompt}], "temperature": 0.2, "max_tokens": 2000})
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise GatewayError(502, "AI_BAD_RESPONSE", "The AI provider returned no message.") from exc
