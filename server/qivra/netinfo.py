"""Network helpers for the launcher: LAN address detection and port probing."""

from __future__ import annotations

import socket
import subprocess
import sys

from .util import is_private_ip


def detect_lan_ips() -> list[str]:
    """Private IPv4 addresses of this machine that phones on the same Wi-Fi can reach.

    Uses the route-based trick (no packets are sent by a UDP connect), then
    falls back to interface enumeration via `ifconfig`/`ipconfig` output.
    """
    found: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        if is_private_ip(ip) and not ip.startswith("127."):
            found.append(ip)
    except OSError:
        pass
    try:
        cmd = ["ipconfig"] if sys.platform == "win32" else ["ifconfig"]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        import re
        for ip in re.findall(r"(?:inet |IPv4 Address[ .]*: )(\d+\.\d+\.\d+\.\d+)", out):
            if is_private_ip(ip) and not ip.startswith("127.") and not ip.startswith("169.254.") and ip not in found:
                found.append(ip)
    except Exception:
        pass
    return found


def port_free(port: int, host: str = "0.0.0.0") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def choose_port(preferred: int, explicit: bool, bind_host: str, tries: int = 20) -> tuple[int, str | None]:
    """Return (port, note). An explicitly requested port is never silently changed."""
    if port_free(preferred, bind_host):
        return preferred, None
    if explicit:
        raise SystemExit(f"Port {preferred} is already in use. Stop the other process or choose --port.")
    for p in range(preferred + 1, preferred + tries):
        if port_free(p, bind_host):
            return p, f"Port {preferred} is in use (on macOS often AirPlay Receiver); using {p} instead."
    raise SystemExit(f"No free port found between {preferred} and {preferred + tries - 1}.")
