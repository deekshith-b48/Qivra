"""Private-VPN (Tailscale/WireGuard) support: detection, Host allow-list, QR alt_urls."""

import subprocess

from fastapi.testclient import TestClient

from tests.helpers import LAN_IP, Env, auth
from qivra import __main__ as launcher
from qivra import netinfo
from qivra.pairing import MAX_ALT_URLS, build_qr_payload

TS_IP = "100.101.102.103"
TS_NAME = "macbook.tail1234.ts.net"

IFCONFIG = f"""
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet {LAN_IP} netmask 0xffffff00 broadcast 192.168.1.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet {TS_IP} --> {TS_IP} netmask 0xffffffff
bridge0: flags=8863<UP> mtu 1500
\tinet 8.8.4.4 netmask 0xffffff00
"""

STATUS = {
    "BackendState": "Running",
    "Self": {"DNSName": f"{TS_NAME}.", "TailscaleIPs": [TS_IP, "fd7a:115c:a1e0::1"]},
}


def test_lan_detection_excludes_vpn_addresses():
    assert netinfo.detect_lan_ips(IFCONFIG) == [LAN_IP]


def test_private_network_from_interfaces_only():
    vpn = netinfo.detect_private_network(IFCONFIG, status=None)
    assert vpn.ips == [TS_IP] and vpn.dns_names == [] and not vpn.tailscale_cli


def test_private_network_from_tailscale_cli_output():
    vpn = netinfo.detect_private_network("", status=STATUS)
    assert vpn.ips == [TS_IP]
    assert vpn.dns_names == [TS_NAME]
    assert vpn.hosts == [TS_NAME, TS_IP]  # MagicDNS first


def test_cli_and_interfaces_are_merged_without_duplicates():
    vpn = netinfo.detect_private_network(IFCONFIG + "\tinet 100.64.0.9 netmask 0xffffffff\n", status=STATUS)
    assert vpn.ips == [TS_IP, "100.64.0.9"]


def test_logged_out_tailscale_is_ignored():
    vpn = netinfo.detect_private_network("", status={"BackendState": "NeedsLogin", "Self": STATUS["Self"]})
    assert vpn.hosts == []


def test_tailscale_cli_is_optional(monkeypatch):
    monkeypatch.setattr(netinfo, "find_tailscale_cli", lambda: None)
    assert netinfo.tailscale_status() is None
    vpn = netinfo.detect_private_network(IFCONFIG)  # status=True → tries the CLI
    assert vpn.ips == [TS_IP] and not vpn.tailscale_cli


def test_tailscale_cli_json_is_parsed(monkeypatch):
    import json

    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(STATUS), stderr="")

    monkeypatch.setattr(netinfo.subprocess, "run", fake_run)
    assert netinfo.tailscale_status("/usr/local/bin/tailscale") == STATUS
    assert calls == [["/usr/local/bin/tailscale", "status", "--json"]]  # read-only: never `up`/`funnel`/`serve`


def test_tailscale_cli_failure_is_harmless(monkeypatch):
    def boom(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 4)

    monkeypatch.setattr(netinfo.subprocess, "run", boom)
    assert netinfo.tailscale_status("/x/tailscale") is None
    monkeypatch.setattr(netinfo.subprocess, "run",
                        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout="not json", stderr=""))
    assert netinfo.tailscale_status("/x/tailscale") is None


def test_name_and_address_helpers():
    assert netinfo.is_cgnat_ip("100.64.0.1") and netinfo.is_cgnat_ip("100.127.255.254")
    assert not netinfo.is_cgnat_ip("100.128.0.1") and not netinfo.is_cgnat_ip("192.168.1.1")
    assert netinfo.is_tailnet_name("mac.tail1234.ts.net.")
    assert not netinfo.is_tailnet_name("ts.net") and not netinfo.is_tailnet_name("evil-ts.net.example.com")


def test_advertised_order_lan_vs_remote():
    lan, vpn = [f"http://{LAN_IP}:5000"], [f"http://{TS_NAME}:5000", f"http://{TS_IP}:5000"]
    local = "http://127.0.0.1:5000"
    assert launcher.advertised_order([], lan, vpn, local, lan=True, remote=False) == lan + vpn
    assert launcher.advertised_order([], lan, vpn, local, lan=True, remote=True) == vpn + lan
    assert launcher.advertised_order([], [], [], local, lan=False, remote=False) == [local]
    assert launcher.advertised_order([lan[0]], lan, vpn, local, lan=True, remote=True) == lan + vpn


def test_remote_flag_implies_lan(monkeypatch):
    seen = {}
    monkeypatch.setattr(launcher, "cmd_serve", lambda args: seen.setdefault("args", args) and 0)
    launcher.main(["serve", "--remote", "--port", "5999"])
    assert seen["args"].lan and seen["args"].remote


def _vpn_env(tmp_path):
    env = Env(tmp_path)
    env.cfg.allowed_hosts |= {TS_IP, TS_NAME}
    env.cfg.advertised_urls = [f"http://{LAN_IP}:5000", f"http://{TS_NAME}:5000", f"http://{TS_IP}:5000"]
    return env


def test_host_allow_list_accepts_vpn_hosts_only_when_detected(tmp_path):
    env = Env(tmp_path)
    for host in (TS_IP, TS_NAME):
        c = TestClient(env.app, base_url=f"http://{host}:5000", client=(TS_IP, 40002))
        assert c.get("/api/health").status_code == 421
    env = _vpn_env(tmp_path / "vpn")
    for host in (TS_IP, TS_NAME):
        c = TestClient(env.app, base_url=f"http://{host}:5000", client=("100.90.1.2", 40002))
        assert c.get("/api/health").status_code == 200
    rebinding = TestClient(env.app, base_url="http://attacker.ts.net.evil.com:5000", client=("100.90.1.2", 40003))
    assert rebinding.get("/api/health").status_code == 421


def test_paired_device_works_over_vpn_host(tmp_path):
    env = _vpn_env(tmp_path)
    vpn_phone = TestClient(env.app, base_url=f"http://{TS_NAME}:5000", client=("100.90.1.2", 40004))
    token, device = env.pair(client=vpn_phone)
    assert vpn_phone.get("/api/v1/pairing/status", headers=auth(token)).status_code == 200


def test_qr_payload_carries_alt_urls(tmp_path):
    env = _vpn_env(tmp_path)
    p = env.challenge()["qr_payload"]
    assert p["server_url"] == f"http://{LAN_IP}:5000"
    assert p["alt_urls"] == [f"http://{TS_NAME}:5000", f"http://{TS_IP}:5000"]
    assert p["version"] == 1  # additive field: older apps ignore it
    text = str(p).lower()
    for word in ("token", "secret", "api_key"):
        assert word not in text


def test_qr_payload_alt_urls_follow_chosen_primary(tmp_path):
    env = _vpn_env(tmp_path)
    r = env.owner.post("/api/v1/pairing/challenges", json={"server_url": f"http://{TS_NAME}:5000"})
    p = r.json()["qr_payload"]
    assert p["server_url"] == f"http://{TS_NAME}:5000"
    assert p["alt_urls"] == [f"http://{LAN_IP}:5000", f"http://{TS_IP}:5000"]


def test_build_qr_payload_alt_urls_dedup_and_cap():
    p = build_qr_payload("http://a:1/", "ABCD2345", "abcdef12", "2030-01-01T00:00:00Z",
                         ["http://a:1", "http://b:1/", "http://b:1"] + [f"http://h{i}:1" for i in range(9)])
    assert p["server_url"] == "http://a:1"
    assert p["alt_urls"][0] == "http://b:1" and len(p["alt_urls"]) == MAX_ALT_URLS
    assert "alt_urls" not in build_qr_payload("http://a:1", "ABCD2345", "abcdef12", "2030-01-01T00:00:00Z")
