"""Network helpers for the launcher: LAN/private-VPN address detection and port probing."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass, field

from .util import is_private_ip

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
# macOS ships the CLI inside the app bundle when Tailscale is installed from the App Store / website.
_TAILSCALE_MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"


def is_cgnat_ip(ip: str) -> bool:
    """100.64.0.0/10: what Tailscale (and many WireGuard setups) assign to peers."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return isinstance(addr, ipaddress.IPv4Address) and addr in _CGNAT


def is_tailnet_name(host: str) -> bool:
    """MagicDNS names (`mac.tail1234.ts.net`) resolve only inside the tailnet."""
    h = host.lower().rstrip(".")
    return h.endswith(".ts.net") and h.count(".") >= 2


def _ifconfig_output() -> str:
    cmd = ["ipconfig"] if sys.platform == "win32" else ["ifconfig"]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return ""


def _ipv4s_in(text: str) -> list[str]:
    return re.findall(r"(?:inet |IPv4 Address[ .]*: )(\d+\.\d+\.\d+\.\d+)", text)


def detect_lan_ips(ifconfig_output: str | None = None) -> list[str]:
    """Private IPv4 addresses of this machine that phones on the same Wi-Fi can reach.

    Uses the route-based trick (no packets are sent by a UDP connect), then
    falls back to interface enumeration via `ifconfig`/`ipconfig` output.
    VPN (100.64/10) addresses are excluded; see `detect_private_network`.
    """
    found: list[str] = []
    if ifconfig_output is None:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
            s.close()
            if is_private_ip(ip) and not ip.startswith("127.") and not is_cgnat_ip(ip):
                found.append(ip)
        except OSError:
            pass
        ifconfig_output = _ifconfig_output()
    for ip in _ipv4s_in(ifconfig_output):
        if (is_private_ip(ip) and not ip.startswith("127.") and not ip.startswith("169.254.")
                and not is_cgnat_ip(ip) and ip not in found):
            found.append(ip)
    return found


@dataclass
class PrivateNetwork:
    """Addresses on a private VPN (Tailscale/WireGuard) that work away from home Wi-Fi."""
    ips: list[str] = field(default_factory=list)
    dns_names: list[str] = field(default_factory=list)
    tailscale_cli: bool = False

    @property
    def hosts(self) -> list[str]:
        # MagicDNS first: it survives Tailscale re-assigning the 100.x address.
        return self.dns_names + self.ips


def find_tailscale_cli() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    if sys.platform == "darwin" and os.path.isfile(_TAILSCALE_MAC_APP):
        return _TAILSCALE_MAC_APP
    return None


def tailscale_status(cli: str | None = None) -> dict | None:
    """`tailscale status --json`, or None when the CLI is missing, logged out or slow. Never required."""
    cli = cli or find_tailscale_cli()
    if not cli:
        return None
    try:
        res = subprocess.run([cli, "status", "--json"], capture_output=True, text=True, timeout=4)
        if res.returncode != 0:
            return None
        data = json.loads(res.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def parse_tailscale_status(data: dict | None) -> tuple[list[str], list[str]]:
    """(ipv4s, MagicDNS names) for this machine from `tailscale status --json`."""
    if not data or data.get("BackendState", "Running") != "Running":
        return [], []
    me = data.get("Self") or {}
    ips = [ip for ip in me.get("TailscaleIPs") or [] if isinstance(ip, str) and is_cgnat_ip(ip)]
    names: list[str] = []
    dns = me.get("DNSName")
    if isinstance(dns, str) and is_tailnet_name(dns):
        names.append(dns.lower().rstrip("."))
    return ips, names


def detect_private_network(ifconfig_output: str | None = None, status: dict | None | bool = True
                           ) -> PrivateNetwork:
    """Tailscale/WireGuard addresses of this machine. Read-only: nothing is started or exposed.

    `status=True` queries the Tailscale CLI if installed; pass a dict (or None) to inject it.
    """
    if ifconfig_output is None:
        ifconfig_output = _ifconfig_output()
    cli_used = False
    if status is True:
        status = tailscale_status()
        cli_used = status is not None
    elif status is not None:
        cli_used = True
    ts_ips, names = parse_tailscale_status(status if isinstance(status, dict) else None)
    ips: list[str] = list(ts_ips)
    for ip in _ipv4s_in(ifconfig_output):
        if is_cgnat_ip(ip) and ip not in ips:
            ips.append(ip)
    return PrivateNetwork(ips=ips, dns_names=names, tailscale_cli=cli_used)


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
