"""Qivra local server launcher.

    python -m qivra serve              # localhost only (default, safest)
    python -m qivra serve --lan        # also reachable from phones on the same Wi-Fi
                                       # (and over Tailscale/WireGuard if this Mac is on one)
    python -m qivra serve --remote     # like --lan, but the QR prefers the private-VPN URL
    python -m qivra pair               # new one-time QR/access ID for a running server
    python -m qivra devices            # list paired devices
    python -m qivra revoke <device_id> # revoke a device credential

URLs are printed only after a real health check against the bound socket.
The server never opens a public tunnel or changes VPN settings; it only detects
an existing private network. See docs/LOCAL_SERVER_AND_QR_PAIRING.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
os.chdir(SERVER_DIR)  # SuperBrain modules use paths relative to backend/

from . import PRODUCT, SERVER_VERSION  # noqa: E402
from .util import format_pairing_code  # noqa: E402

BOLD, DIM, GREEN, YELLOW, RED, RESET = (("\033[1m", "\033[2m", "\033[32m", "\033[33m", "\033[31m", "\033[0m")
                                        if sys.stdout.isatty() else ("",) * 6)


def _http(method: str, url: str, body: dict | None = None, timeout: float = 3.0) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}


def print_qr(payload: dict) -> bool:
    try:
        import segno
    except ImportError:
        print(f"  {YELLOW}QR code unavailable: install 'segno' (pip install segno). Use manual entry.{RESET}")
        return False
    qr = segno.make(json.dumps(payload, separators=(",", ":")), error="m")
    qr.terminal(compact=True, border=2)
    return True


def show_pairing(challenge: dict, show_qr: bool = True) -> None:
    print(f"\n{BOLD}Pairing{RESET}")
    print(f"  Server URL : {challenge['server_url']}")
    for alt in (challenge.get("qr_payload") or {}).get("alt_urls", []):
        print(f"  Also       : {alt}  {DIM}(the phone falls back to it automatically){RESET}")
    print(f"  Access ID  : {BOLD}{format_pairing_code(challenge['pairing_id'])}{RESET}  "
          f"{DIM}(one-time, expires {challenge['expires_at']}, ~{challenge['ttl_seconds'] // 60} min){RESET}")
    if show_qr and challenge.get("qr_payload"):
        ok = print_qr(challenge["qr_payload"])
        print(f"  QR code    : {'shown above' if ok else 'unavailable'}")
    print(f"  {DIM}In Qivra: Settings → Connect to My Server → Scan QR code (or Enter manually).{RESET}")


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .app import create_app
    from .config import QivraConfig
    from .netinfo import PrivateNetwork, choose_port, detect_lan_ips, detect_private_network

    from . import ai_gateway, transcribers
    from .config import SERVER_DIR

    ai_gateway.load_env_file(SERVER_DIR / ai_gateway.ENV_FILE_NAME)
    cfg = QivraConfig()
    cfg.lan_enabled = bool(args.lan)
    bind_host = "0.0.0.0" if args.lan else "127.0.0.1"
    port, port_note = choose_port(args.port, args.port_explicit, bind_host)
    cfg.port = port
    scheme = "https" if args.tls_cert else "http"
    cfg.scheme = scheme

    lan_ips: list[str] = []
    vpn = PrivateNetwork()
    if args.lan:
        lan_ips = detect_lan_ips()
        vpn = detect_private_network()
        cfg.allowed_hosts |= set(lan_ips) | set(vpn.hosts)
    else:
        cfg.allowed_hosts.add("10.0.2.2")  # Android emulator → host loopback
    for h in args.allow_host or []:
        cfg.allowed_hosts.add(h.lower())

    local_url = f"{scheme}://127.0.0.1:{port}"
    lan_urls = [f"{scheme}://{ip}:{port}" for ip in lan_ips]
    vpn_urls = [f"{scheme}://{h}:{port}" for h in vpn.hosts]
    advertised = advertised_order(list(args.advertise_url or []), lan_urls, vpn_urls, local_url,
                                  lan=args.lan, remote=args.remote)
    cfg.advertised_urls = advertised

    print(f"{BOLD}QIVRA LOCAL SERVER{RESET}  {DIM}v{SERVER_VERSION}{RESET}")
    if port_note:
        print(f"  {YELLOW}{port_note}{RESET}")
    app = create_app(cfg, include_legacy=not args.no_legacy)
    services = app.state.qivra

    ssl_kwargs = {"ssl_certfile": args.tls_cert, "ssl_keyfile": args.tls_key} if args.tls_cert else {}
    server = uvicorn.Server(uvicorn.Config(app, host=bind_host, port=port, log_level="warning",
                                           access_log=False, **ssl_kwargs))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and thread.is_alive() and time.time() < deadline:
        time.sleep(0.1)
    if not server.started:
        print(f"  {RED}Status: FAILED — the server did not start (see errors above).{RESET}")
        return 1

    if scheme == "http":
        code, health = _http("GET", f"{local_url}/api/health")
    else:
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            with urllib.request.urlopen(f"{local_url}/api/health", context=ctx, timeout=3) as r:
                code, health = r.status, json.loads(r.read())
        except Exception:
            code, health = 0, {}
    if code != 200 or health.get("product") != PRODUCT:
        print(f"  {RED}Status: FAILED — health check on {local_url}/api/health returned {code}.{RESET}")
        server.should_exit = True
        return 1

    print(f"Status: {GREEN}Running{RESET} {DIM}(health check passed){RESET}")
    print(f"\n{BOLD}Local{RESET}\n  {local_url}   {DIM}(API docs: {local_url}/docs){RESET}")
    if args.lan:
        print(f"\n{BOLD}Server (LAN){RESET}")
        if not lan_urls:
            print(f"  {YELLOW}No private LAN address detected. Connect this machine to Wi-Fi/Ethernet.{RESET}")
        for u in lan_urls:
            c, h = _http("GET", f"{u}/api/health") if scheme == "http" else (0, {})
            verdict = (f"{GREEN}reachable from this machine{RESET}" if c == 200 and h.get("product") == PRODUCT
                       else f"{YELLOW}not verified from this machine{RESET}")
            print(f"  {u}   ({verdict})")
        print(f"  {DIM}If the phone cannot connect, allow incoming connections for Python in the firewall.{RESET}")
        print(f"\n{BOLD}Private network (works anywhere){RESET}")
        if vpn_urls:
            for u in vpn_urls:
                c, h = _http("GET", f"{u}/api/health") if scheme == "http" else (0, {})
                verdict = ("reachable from this machine" if c == 200 and h.get("product") == PRODUCT
                           else "not verified from this machine")
                print(f"  {u}   {DIM}({verdict}; Tailscale/WireGuard — only your own devices can reach it){RESET}")
            if not args.remote:
                print(f"  {DIM}Included in the QR as a fallback. Use --remote to make it the primary URL.{RESET}")
        else:
            print(f"  {DIM}None detected. To use Qivra away from home: install Tailscale on this Mac and the phone, "
                  f"sign in with the same account, restart with --remote and pair again.{RESET}")
    print(f"\n{BOLD}Security{RESET}")
    print(f"  Local-network pairing: {'enabled' if args.lan else 'disabled (localhost only; use --lan)'}")
    print("  Public exposure: disabled (no tunnels are started; VPN addresses are private to your tailnet)")
    print(f"  Transport: {'HTTPS' if scheme == 'https' else 'HTTP — not encrypted in transit; use only on a trusted network'}")
    print(f"  Server ID: {services.store.server_id}")
    gw = ai_gateway.describe()
    if gw["enabled"]:
        print(f"  AI for paired phones: {gw['model']} via {gw['upstream']} "
              f"{DIM}(key stays on this machine, not shown){RESET}")
    else:
        print(f"  AI for paired phones: off {DIM}(set QIVRA_AI_* in server/{ai_gateway.ENV_FILE_NAME}){RESET}")
    print(f"  Transcription: {transcribers.banner()}")
    paired = services.store.list_devices()
    print(f"  Paired devices: {sum(1 for d in paired if not d.revoked_at)} active, "
          f"{sum(1 for d in paired if d.revoked_at)} revoked")

    show_pairing(services.pairing.create_challenge(advertised[0] if advertised else None), not args.no_qr)
    interactive = sys.stdin.isatty()
    if interactive:
        print(f"\n{DIM}Enter = new QR/access ID · d = devices · q = quit{RESET}")
    try:
        while thread.is_alive():
            if not interactive:
                time.sleep(1)
                continue
            line = sys.stdin.readline()
            if not line:
                time.sleep(1)
                continue
            cmd = line.strip().lower()
            if cmd in ("q", "quit", "exit"):
                break
            if cmd == "d":
                for d in services.store.list_devices():
                    state = "revoked" if d.revoked_at else "active"
                    print(f"  {d.id}  {d.name:<24} {state:<8} last seen {d.last_seen_at or '—'}")
                continue
            show_pairing(services.pairing.create_challenge(advertised[0] if advertised else None), not args.no_qr)
    except KeyboardInterrupt:
        pass
    print("Stopping Qivra server…")
    server.should_exit = True
    services.jobs.stop()
    thread.join(timeout=5)
    return 0


def advertised_order(explicit: list[str], lan_urls: list[str], vpn_urls: list[str], local_url: str,
                     lan: bool, remote: bool) -> list[str]:
    """QR URL order: explicit --advertise-url first, then LAN or VPN depending on --remote."""
    if not lan:
        ordered = explicit + [local_url]
    elif remote:
        ordered = explicit + vpn_urls + lan_urls
    else:
        ordered = explicit + lan_urls + vpn_urls
    out: list[str] = []
    for u in ordered:
        if u not in out:
            out.append(u)
    return out


def _owner_base(args) -> str:
    return f"http://127.0.0.1:{args.port}"


def cmd_pair(args: argparse.Namespace) -> int:
    body = {"server_url": args.url} if args.url else {}
    code, data = _http("POST", f"{_owner_base(args)}/api/v1/pairing/challenges", body)
    if code != 200:
        print(f"Failed ({code}): {data.get('error', {}).get('message', 'is the server running on this port?')}")
        return 1
    show_pairing(data, not args.no_qr)
    return 0


def cmd_devices(args: argparse.Namespace) -> int:
    code, data = _http("GET", f"{_owner_base(args)}/api/v1/devices")
    if code != 200:
        print(f"Failed ({code}).")
        return 1
    for d in data["devices"]:
        print(f"{d['id']}  {d['name']:<24} {'revoked' if d['revoked'] else 'active':<8} last seen {d['last_seen_at']}")
    if not data["devices"]:
        print("No paired devices.")
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    code, data = _http("POST", f"{_owner_base(args)}/api/v1/devices/{args.device_id}/revoke")
    print("Revoked." if code == 200 else f"Failed ({code}): {data.get('error', {}).get('message', '')}")
    return 0 if code == 200 else 1


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)  # banner must appear immediately when piped
    except AttributeError:
        pass
    p = argparse.ArgumentParser(prog="python -m qivra", description="Qivra local server")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="start the server")
    s.add_argument("--lan", action="store_true", help="listen on all interfaces for phones on the same network")
    s.add_argument("--remote", action="store_true",
                   help="implies --lan; put the Tailscale/WireGuard URL first in the QR (works away from home)")
    s.add_argument("--port", type=int, default=None)
    s.add_argument("--no-qr", action="store_true")
    s.add_argument("--no-legacy", action="store_true", help="do not mount the legacy endpoints")
    s.add_argument("--tls-cert")
    s.add_argument("--tls-key")
    s.add_argument("--allow-host", action="append", help="extra Host header value to accept (e.g. a VPN IP)")
    s.add_argument("--advertise-url", action="append", help="URL to put in the QR (e.g. http://100.x.y.z:5000)")
    for name in ("pair", "devices", "revoke"):
        sp = sub.add_parser(name)
        sp.add_argument("--port", type=int, default=5000)
        if name == "pair":
            sp.add_argument("--url", help="one of the server's advertised URLs")
            sp.add_argument("--no-qr", action="store_true")
        if name == "revoke":
            sp.add_argument("device_id")
    args = p.parse_args(argv)
    if args.cmd == "serve":
        args.lan = args.lan or args.remote
        args.port_explicit = args.port is not None
        args.port = args.port or int(os.getenv("PORT", "5000"))
        if bool(args.tls_cert) != bool(args.tls_key):
            p.error("--tls-cert and --tls-key must be used together")
        return cmd_serve(args)
    return {"pair": cmd_pair, "devices": cmd_devices, "revoke": cmd_revoke}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
