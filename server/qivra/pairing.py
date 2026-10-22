"""One-time QR pairing and per-device credentials.

Protocol (see docs/LOCAL_SERVER_AND_QR_PAIRING.md):
  1. The laptop owner (loopback only) creates a challenge: an 8-character code
     (40 bits) that expires after `pairing_ttl_s` seconds and can be used once.
  2. The QR code carries the server URL (plus optional alternate URLs, e.g. a
     Tailscale address), server_id, pairing code and expiry — never the device credential, the legacy token, or any provider key.
  3. The phone posts the code to /api/v1/pairing/complete. The challenge is
     consumed atomically (replay-safe) and a random device token is returned once.
  4. Only the SHA-256 hash of the device token is stored. Revocation is immediate.
Brute force is bounded by per-IP rate limits plus a global failure budget that
invalidates every open challenge when exceeded.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import timedelta

from . import PAIRING_PAYLOAD_VERSION, PRODUCT
from .config import QivraConfig
from .store import Device, QivraStore
from .util import (format_pairing_code, iso, new_device_token, new_pairing_code, normalize_pairing_code,
                   now_iso, utc_now)

logger = logging.getLogger(__name__)


class PairingError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class RateLimiter:
    """Sliding-window limiter keyed by an arbitrary string. In-memory by design:
    a restart resets counters, but challenges also die with their short TTL."""

    def __init__(self, clock=time.monotonic):
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()
        self._clock = clock

    def hit(self, key: str, limit: int, window_s: float) -> bool:
        """Record a hit; return False if the key is over its limit."""
        now = self._clock()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] > window_s:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    def count(self, key: str, window_s: float) -> int:
        now = self._clock()
        with self._lock:
            q = self._hits.get(key, deque())
            return sum(1 for t in q if now - t <= window_s)

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


class PairingService:
    def __init__(self, store: QivraStore, config: QivraConfig, limiter: RateLimiter | None = None):
        self.store = store
        self.config = config
        self.limiter = limiter or RateLimiter()

    # ── challenge ─────────────────────────────────────────────────────────
    def create_challenge(self, server_url: str | None = None) -> dict:
        code = new_pairing_code()
        expires = utc_now() + timedelta(seconds=self.config.pairing_ttl_s)
        expires_at = iso(expires)
        self.store.create_pairing(code, expires_at)
        url = server_url or (self.config.advertised_urls[0] if self.config.advertised_urls else None)
        alts = [u for u in self.config.advertised_urls if url and u.rstrip("/") != url.rstrip("/")]
        payload = build_qr_payload(url, code, self.store.server_id, expires_at, alts) if url else None
        return {
            "pairing_id": code,
            "pairing_id_display": format_pairing_code(code),
            "expires_at": expires_at,
            "ttl_seconds": self.config.pairing_ttl_s,
            "server_id": self.store.server_id,
            "server_url": url,
            "qr_payload": payload,
        }

    # ── completion ───────────────────────────────────────────────────────
    def complete(self, raw_code: str, device_name: str, platform: str | None, client_ip: str | None
                 ) -> tuple[Device, str]:
        ip_key = f"pair-ip:{client_ip or 'unknown'}"
        if not self.limiter.hit(ip_key, self.config.pairing_ip_limit, 60):
            raise PairingError("RATE_LIMITED", "Too many pairing attempts. Wait a minute and try again.", 429)

        code = normalize_pairing_code(raw_code)
        if len(code) != 8 or any(c not in "0123456789ABCDEFGHJKMNPQRSTVWXYZ" for c in code):
            self._record_failure()
            raise PairingError("PAIRING_INVALID", "The access ID is not in the expected format.", 400)

        now = now_iso()
        row = self.store.get_pairing(code)
        if row is None:
            self._record_failure()
            raise PairingError("PAIRING_INVALID", "Unknown access ID. Generate a new QR code on the server.", 401)
        if row["invalidated"]:
            raise PairingError("PAIRING_INVALIDATED",
                               "This access ID was invalidated. Generate a new QR code on the server.", 410)
        if row["used_at"] is not None:
            self._record_failure()
            raise PairingError("PAIRING_ALREADY_USED", "This access ID was already used. Generate a new one.", 410)
        if row["expires_at"] <= now:
            raise PairingError("PAIRING_EXPIRED", "This access ID has expired. Generate a new QR code.", 410)
        if not self.store.consume_pairing(code, now):
            # Lost a race with a concurrent request using the same code.
            raise PairingError("PAIRING_ALREADY_USED", "This access ID was already used. Generate a new one.", 410)

        name = (device_name or "Android device").strip()[:60] or "Android device"
        token = new_device_token()
        device = self.store.create_device(name, (platform or "")[:20] or None, token, client_ip)
        self.store.attach_pairing_device(code, device.id)
        self.limiter.reset(ip_key)
        logger.info("Paired device %r (%s) from %s", device.name, device.id, client_ip or "unknown")  # never the code or token
        return device, token

    def _record_failure(self) -> None:
        cfg = self.config
        ok = self.limiter.hit("pair-fail-global", cfg.pairing_global_fail_limit, cfg.pairing_global_fail_window_s)
        if not ok:
            # Too many wrong codes across all clients: burn every open challenge.
            logger.warning("Too many failed pairing attempts; all open access IDs were invalidated")
            self.store.invalidate_active_pairings()
            self.limiter.reset("pair-fail-global")

    # ── credentials ──────────────────────────────────────────────────────
    def authenticate(self, token: str | None) -> Device | None:
        if not token or not token.startswith("qv1_") or len(token) > 100:
            return None
        device = self.store.device_by_token(token)
        if device is None or device.revoked_at is not None:
            return None
        return device


MAX_ALT_URLS = 4


def build_qr_payload(server_url: str, code: str, server_id: str, expires_at: str,
                     alt_urls: list[str] | None = None) -> dict:
    """`alt_urls` is optional and additive, so version-1 apps simply ignore it."""
    payload = {
        "version": PAIRING_PAYLOAD_VERSION,
        "product": PRODUCT,
        "server_url": server_url.rstrip("/"),
        "server_id": server_id,
        "pairing_id": code,
        "expires_at": expires_at,
    }
    primary = payload["server_url"]
    alts: list[str] = []
    for u in alt_urls or []:
        u = u.rstrip("/")
        if u and u != primary and u not in alts:
            alts.append(u)
    if alts:
        payload["alt_urls"] = alts[:MAX_ALT_URLS]
    return payload
