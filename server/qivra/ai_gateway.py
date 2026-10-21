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
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

ENV_FILE_NAME = "qivra.env"
_ENV_KEYS = ("QIVRA_AI_BASE_URL", "QIVRA_AI_API_KEY", "QIVRA_AI_MODEL", "QIVRA_AI_EMBEDDING_MODEL",
             "QIVRA_TRANSCRIBER", "QIVRA_GROQ_WHISPER_MODEL")
CHAT_FIELDS = {"messages", "temperature", "max_tokens", "top_p", "stop", "tools", "tool_choice", "response_format"}
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
    return {
        "base_url": base,
        "host": host,
        "model": model,
        "embedding_model": os.getenv("QIVRA_AI_EMBEDDING_MODEL", "").strip() or None,
        "api_key": os.getenv("QIVRA_AI_API_KEY", "").strip() or None,
    }


def describe() -> dict:
    """Public description for paired devices (no key)."""
    cfg = config()
    if cfg is None:
        return {"enabled": False}
    return {"enabled": True, "upstream": cfg["host"], "model": cfg["model"],
            "embedding_model": cfg["embedding_model"], "external": not _private_host(cfg["host"])}


def _post(cfg: dict, path: str, payload: dict, timeout: float) -> dict:
    import httpx

    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    try:
        res = httpx.post(cfg["base_url"] + path, json=payload, headers=headers, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise GatewayError(504, "AI_TIMEOUT", "The AI provider timed out.") from exc
    except httpx.HTTPError as exc:
        raise GatewayError(502, "AI_UNREACHABLE", "The server could not reach the AI provider.") from exc
    if res.status_code in (401, 403):
        raise GatewayError(res.status_code, "AI_KEY_REJECTED", "The AI provider rejected the server's API key.")
    if res.status_code == 429:
        raise GatewayError(429, "AI_RATE_LIMITED", "The AI provider rate limit was reached. Try again shortly.")
    if res.status_code == 404:
        raise GatewayError(502, "AI_MODEL_NOT_FOUND", f"The AI provider does not offer model '{payload.get('model')}'.")
    if res.status_code >= 400:
        logger.warning("AI provider returned HTTP %s", res.status_code)
        raise GatewayError(502, "AI_PROVIDER_ERROR", f"The AI provider returned HTTP {res.status_code}.")
    try:
        return res.json()
    except ValueError as exc:
        raise GatewayError(502, "AI_BAD_RESPONSE", "The AI provider returned invalid JSON.") from exc


def chat(body: dict[str, Any]) -> dict:
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
    return _post(cfg, "/chat/completions", payload, timeout=120.0)


def embeddings(body: dict[str, Any]) -> dict:
    cfg = config()
    if cfg is None or not cfg["embedding_model"]:
        raise GatewayError(503, "AI_NOT_CONFIGURED", "No embedding model is configured on the server.")
    inputs = body.get("input")
    if isinstance(inputs, str):
        inputs = [inputs]
    if not isinstance(inputs, list) or not inputs or len(inputs) > MAX_EMBED_INPUTS or not all(isinstance(i, str) for i in inputs):
        raise GatewayError(400, "INVALID_REQUEST", f"input must be 1–{MAX_EMBED_INPUTS} strings.")
    return _post(cfg, "/embeddings", {"model": cfg["embedding_model"], "input": inputs}, timeout=60.0)


def generate(prompt: str) -> str:
    """Single-prompt completion for server-side jobs (enrichment, agent, reports)."""
    data = chat({"messages": [{"role": "user", "content": prompt}], "temperature": 0.2, "max_tokens": 2000})
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise GatewayError(502, "AI_BAD_RESPONSE", "The AI provider returned no message.") from exc
