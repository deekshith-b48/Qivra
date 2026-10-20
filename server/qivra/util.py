"""Small shared helpers: time, ids, hashing and IP classification."""

from __future__ import annotations

import hashlib
import ipaddress
import re
import secrets
from datetime import datetime, timezone

# Crockford base32 without I, L, O, U — easy to read aloud and type.
PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ENTITY_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    """ISO-8601 UTC with a trailing Z and millisecond precision."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return iso(utc_now())


def parse_iso(value: str) -> datetime:
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_pairing_code(length: int = 8) -> str:
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(length))


def normalize_pairing_code(raw: str) -> str:
    """Accept user-typed codes: case-insensitive, dashes/spaces ignored, O->0, I/L->1."""
    s = re.sub(r"[\s\-_]", "", (raw or "").upper())
    return s.replace("O", "0").replace("I", "1").replace("L", "1")


def format_pairing_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}" if len(code) == 8 else code


def mask_secret(value: str | None, keep: int = 2) -> str:
    if not value:
        return "—"
    if len(value) <= keep * 2:
        return "*" * len(value)
    return f"{value[:keep]}{'*' * 6}{value[-keep:]}"


def new_device_token() -> str:
    return "qv1_" + secrets.token_urlsafe(32)


def new_id(prefix: str = "") -> str:
    return prefix + secrets.token_hex(8)


def is_valid_entity_id(value: str) -> bool:
    return bool(value) and bool(ENTITY_ID_RE.match(value))


def is_loopback_ip(host: str | None) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host.split("%")[0]).is_loopback
    except ValueError:
        return host == "localhost"


def is_private_ip(host: str) -> bool:
    """RFC1918, loopback, link-local, CGNAT (Tailscale) and IPv6 ULA."""
    try:
        ip = ipaddress.ip_address(host.split("%")[0])
    except ValueError:
        return False
    if ip.is_loopback or ip.is_link_local or ip.is_private:
        return True
    return isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10")


def strip_port(host_header: str) -> str:
    """Return the hostname part of a Host header ('[::1]:5000' -> '::1')."""
    h = (host_header or "").strip().lower()
    if h.startswith("["):
        end = h.find("]")
        return h[1:end] if end != -1 else h
    if h.count(":") == 1:
        return h.split(":", 1)[0]
    return h
