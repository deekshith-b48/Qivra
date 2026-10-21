"""Honest AI availability on top of SuperBrain's ModelRouter.

SuperBrain's router reports Ollama as "always available"; here we only claim a
provider is usable when it has a key or a reachable local endpoint.
"""

from __future__ import annotations

import os
import threading
import time

from . import ai_gateway

_ollama_cache: tuple[float, bool] = (0.0, False)
_lock = threading.Lock()


def _ollama_reachable() -> bool:
    global _ollama_cache
    with _lock:
        ts, ok = _ollama_cache
        if time.monotonic() - ts < 60:
            return ok
    try:
        import httpx
        base = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
        ok = httpx.get(f"{base}/api/tags", timeout=1.0).status_code == 200
    except Exception:
        ok = False
    with _lock:
        _ollama_cache = (time.monotonic(), ok)
    return ok


def provider_status() -> dict:
    if ai_gateway.config() is not None:
        return {"available": True, "providers": {"gateway": True}, "gateway": ai_gateway.describe()}
    try:
        from core.model_router import get_router
        providers = dict(get_router().get_available_providers())
    except Exception as exc:  # router missing deps or config
        return {"available": False, "providers": {}, "error": type(exc).__name__}
    providers["ollama"] = _ollama_reachable()
    return {"available": any(providers.values()), "providers": providers}


def generate(prompt: str) -> tuple[str, str]:
    """Return (text, provider_label). Raises RuntimeError when nothing is configured."""
    cfg = ai_gateway.config()
    if cfg is not None:
        try:
            return ai_gateway.generate(prompt), f"server:{cfg['host']}:{cfg['model']}"
        except ai_gateway.GatewayError as exc:
            raise RuntimeError(exc.code) from exc
    status = provider_status()
    if not status["available"]:
        raise RuntimeError("NO_PROVIDER")
    from core.model_router import get_router
    text = get_router().generate_text(prompt)
    keyed = [p for p, ok in status["providers"].items() if ok]
    return text, "server:" + "+".join(keyed)
