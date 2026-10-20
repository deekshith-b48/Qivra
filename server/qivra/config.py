"""Runtime configuration for the Qivra server (set by the launcher or tests)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class QivraConfig:
    db_path: Path = field(default_factory=lambda: Path(os.getenv("DATABASE_PATH", str(SERVER_DIR / "superbrain.db"))))
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("QIVRA_DATA_DIR", str(SERVER_DIR / "data"))))
    # LAN mode must be explicitly enabled (launcher --lan or QIVRA_LAN=1).
    lan_enabled: bool = field(default_factory=lambda: _env_bool("QIVRA_LAN"))
    port: int = 5000
    scheme: str = "http"
    # Hostnames/IPs accepted in the Host header (DNS-rebinding protection).
    allowed_hosts: set[str] = field(default_factory=lambda: {"localhost", "127.0.0.1", "::1"})
    # Extra Origin values allowed to call the API from a browser context (none by default).
    allowed_origins: set[str] = field(default_factory=lambda: {
        o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()
    })
    # Client addresses treated as "the laptop owner" for admin operations.
    loopback_clients: set[str] = field(default_factory=lambda: {"127.0.0.1", "::1"})
    pairing_ttl_s: int = field(default_factory=lambda: int(os.getenv("QIVRA_PAIRING_TTL_S", "300")))
    # Max failed pairing attempts (all clients) per window before active challenges are invalidated.
    pairing_global_fail_limit: int = 20
    pairing_global_fail_window_s: int = 600
    pairing_ip_limit: int = 10           # requests per minute per IP on pairing endpoints
    json_max_bytes: int = 2 * 1024 * 1024
    upload_max_bytes: int = field(default_factory=lambda: int(os.getenv("QIVRA_UPLOAD_MAX_BYTES", str(200 * 1024 * 1024))))
    # The legacy SuperBrain 8-character token is accepted only from loopback unless explicitly allowed.
    allow_legacy_token_on_lan: bool = field(default_factory=lambda: _env_bool("QIVRA_ALLOW_LEGACY_LAN_TOKEN"))
    start_job_worker: bool = True
    # Base URLs advertised in QR codes (filled by the launcher with the real bound addresses).
    advertised_urls: list[str] = field(default_factory=list)

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "uploads").mkdir(parents=True, exist_ok=True)


_config: QivraConfig | None = None


def get_config() -> QivraConfig:
    global _config
    if _config is None:
        _config = QivraConfig()
    return _config


def set_config(cfg: QivraConfig) -> None:
    global _config
    _config = cfg
