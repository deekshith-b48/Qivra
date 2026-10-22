"""Assemble the Qivra API on top of the SuperBrain FastAPI app."""

from __future__ import annotations

import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .api_v1 import router
from .config import QivraConfig, get_config, set_config
from .jobs import JobRunner
from .pairing import PairingService, RateLimiter
from .security import ApiError, error_body, install_security_middleware
from .store import QivraStore


class QivraServices:
    def __init__(self, config: QivraConfig):
        config.ensure_dirs()
        self.config = config
        self.store = QivraStore(config.db_path)
        self.pairing = PairingService(self.store, config, RateLimiter())
        self.jobs = JobRunner(self.store)
        self._last_touch: dict[str, float] = {}

    def touch_device(self, device_id: str, ip: str | None) -> None:
        now = time.monotonic()
        if now - self._last_touch.get(device_id, 0) > 30:
            self._last_touch[device_id] = now
            self.store.touch_device(device_id, ip)


def create_app(config: QivraConfig | None = None, *, include_legacy: bool = True) -> FastAPI:
    cfg = config or get_config()
    set_config(cfg)
    if include_legacy:
        import api as legacy  # SuperBrain app: legacy routes + analysis queue worker
        app = legacy.app
    else:
        app = FastAPI(title="Qivra")

    services = QivraServices(cfg)
    app.state.qivra = services
    mirrored = services.store.mirror_legacy_analyses()
    if mirrored:
        print(f"[Qivra] Mirrored {mirrored} SuperBrain item(s) into the Qivra library")

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse(status_code=exc.status, content=error_body(exc.code, exc.message, **exc.extra))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        if request.url.path.startswith("/api/"):
            first = exc.errors()[0] if exc.errors() else {}
            where = ".".join(str(p) for p in first.get("loc", []) if p != "body")
            return JSONResponse(status_code=422, content=error_body(
                "VALIDATION_ERROR", f"{where}: {first.get('msg', 'invalid request')}".strip(": ")))
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    install_security_middleware(app, get_config)
    app.include_router(router)
    if cfg.start_job_worker:
        services.jobs.start()
        from . import embeddings
        embeddings.warm_up()  # load the local embedding model in the background
    return app
