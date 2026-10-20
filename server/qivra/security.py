"""Request-level security for the local server.

* Host-header allow-list (DNS-rebinding protection) for every route, legacy included.
* Origin allow-list: browsers always send Origin on cross-site requests; the
  Android app does not. Unknown origins are rejected outright — CORS is not
  treated as authentication.
* Content-Length cap for JSON routes (uploads have their own streaming cap).
* Auth dependencies: paired-device bearer credential, or "owner" (a request
  that arrives on loopback with a loopback Host header — i.e. the laptop user).
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from .config import QivraConfig
from .store import Device
from .util import is_loopback_ip, strip_port


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}


def error_body(code: str, message: str, **extra) -> dict:
    return {"error": {"code": code, "message": message, **extra}}


def client_ip(request: Request) -> str | None:
    # X-Forwarded-For is deliberately ignored: there is no trusted proxy in front of this server.
    return request.client.host if request.client else None


def host_allowed(host_header: str, cfg: QivraConfig) -> bool:
    host = strip_port(host_header)
    return bool(host) and host in cfg.allowed_hosts


def is_owner_request(request: Request, cfg: QivraConfig) -> bool:
    ip = client_ip(request)
    host = strip_port(request.headers.get("host", ""))
    ip_ok = ip in cfg.loopback_clients or is_loopback_ip(ip)
    host_ok = host in ("localhost", "127.0.0.1", "::1") or host in cfg.loopback_clients
    return ip_ok and host_ok


def install_security_middleware(app, get_cfg) -> None:
    @app.middleware("http")
    async def qivra_guard(request: Request, call_next):
        cfg: QivraConfig = get_cfg()
        if not host_allowed(request.headers.get("host", ""), cfg):
            return JSONResponse(status_code=421, content=error_body(
                "HOST_NOT_ALLOWED", "Host header not allowed by this Qivra server."))
        origin = request.headers.get("origin")
        if origin and origin not in cfg.allowed_origins:
            return JSONResponse(status_code=403, content=error_body(
                "ORIGIN_NOT_ALLOWED", "Cross-origin requests are not allowed."))
        path = request.url.path
        if path.startswith("/api/") and not path.endswith("/media"):
            length = request.headers.get("content-length")
            if length and length.isdigit() and int(length) > cfg.json_max_bytes:
                return JSONResponse(status_code=413, content=error_body(
                    "PAYLOAD_TOO_LARGE", f"Request body exceeds {cfg.json_max_bytes} bytes."))
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-store")
        return response


def bearer_token(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def device_from_request(request: Request) -> Device | None:
    services = request.app.state.qivra
    device = services.pairing.authenticate(bearer_token(request))
    if device is not None:
        services.touch_device(device.id, client_ip(request))
    return device
