"""Pairing, credentials, revocation, rate limiting and request-level security."""

import json
from datetime import timedelta

from fastapi.testclient import TestClient

from tests.helpers import LAN_IP, PHONE_IP, Env, auth
from qivra.pairing import build_qr_payload
from qivra.util import format_pairing_code, iso, normalize_pairing_code, utc_now


def test_health_is_public_and_leaks_no_secrets(env):
    r = env.phone.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["product"] == "Qivra" and body["status"] == "ok"
    assert body["server_id"] == env.services.store.server_id
    text = json.dumps(body).lower()
    for word in ("token", "secret", "pairing_id", "password", "api_key"):
        assert word not in text


def test_qr_payload_shape_contains_no_credentials(env):
    ch = env.challenge()
    p = ch["qr_payload"]
    assert set(p) == {"version", "product", "server_url", "server_id", "pairing_id", "expires_at"}
    assert p["version"] == 1 and p["product"] == "Qivra"
    assert p["server_url"] == f"http://{LAN_IP}:5000"
    assert len(p["pairing_id"]) == 8
    assert p == build_qr_payload(p["server_url"], p["pairing_id"], p["server_id"], p["expires_at"])


def test_pairing_codes_are_random_and_normalised(env):
    codes = {env.challenge()["pairing_id"] for _ in range(30)}
    assert len(codes) == 30
    assert normalize_pairing_code(" ab1o-il2z ") == "AB10112Z"
    assert format_pairing_code("ABCD2345") == "ABCD-2345"


def test_challenge_creation_is_owner_only(env):
    r = env.phone.post("/api/v1/pairing/challenges")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "OWNER_ONLY"


def test_pairing_success_issues_device_credential(env):
    token, device = env.pair()
    assert token.startswith("qv1_") and len(token) > 40
    assert device["name"] == "Pixel 8" and device["revoked"] is False
    r = env.phone.get("/api/v1/pairing/status", headers=auth(token))
    assert r.status_code == 200
    assert r.json()["device"]["id"] == device["id"]
    # Only the hash of the credential is stored.
    raw = env.services.store._conn.execute("SELECT token_hash FROM qv_devices").fetchone()[0]
    assert token not in raw and len(raw) == 64


def test_unauthorized_and_invalid_credentials(env):
    assert env.phone.get("/api/v1/pairing/status").json()["error"]["code"] == "UNAUTHORIZED"
    r = env.phone.get("/api/v1/pairing/status", headers=auth("qv1_" + "x" * 43))
    assert r.status_code == 401 and r.json()["error"]["code"] == "INVALID_CREDENTIAL"
    for path in ("/api/v1/items", "/api/v1/reports", "/api/v1/devices"):
        assert env.phone.get(path).status_code == 401


def test_replayed_challenge_is_rejected(env):
    ch = env.challenge()
    body = {"pairing_id": ch["pairing_id"], "device_name": "A"}
    assert env.phone.post("/api/v1/pairing/complete", json=body).status_code == 200
    r = env.phone.post("/api/v1/pairing/complete", json=body)
    assert r.status_code == 410 and r.json()["error"]["code"] == "PAIRING_ALREADY_USED"
    assert len(env.services.store.list_devices()) == 1


def test_expired_challenge_is_rejected(env):
    ch = env.challenge()
    past = iso(utc_now() - timedelta(seconds=1))
    env.services.store._conn.execute("UPDATE qv_pairing SET expires_at=?", (past,))
    env.services.store._conn.commit()
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"]})
    assert r.status_code == 410 and r.json()["error"]["code"] == "PAIRING_EXPIRED"


def test_malformed_and_unknown_codes(env):
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": "!!!!-????"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "PAIRING_INVALID"
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": "ZZZZ-ZZZZ"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "PAIRING_INVALID"
    r = env.phone.post("/api/v1/pairing/complete", json={})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_wrong_server_id_is_rejected(env):
    ch = env.challenge()
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"], "server_id": "other"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "WRONG_SERVER"
    # The challenge was not consumed by the rejected attempt.
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"]})
    assert r.status_code == 200


def test_per_ip_rate_limit(env):
    codes = [env.phone.post("/api/v1/pairing/complete", json={"pairing_id": "ZZZZZZZ" + str(i % 10)}).status_code
             for i in range(12)]
    assert 429 in codes
    assert codes.index(429) == env.cfg.pairing_ip_limit


def test_global_bruteforce_budget_invalidates_open_challenges(tmp_path):
    env = Env(tmp_path, pairing_global_fail_limit=5, pairing_ip_limit=100)
    ch = env.challenge()
    for i in range(6):
        attacker = TestClient(env.app, base_url=f"http://{LAN_IP}:5000", client=(f"192.168.1.{100 + i}", 1))
        attacker.post("/api/v1/pairing/complete", json={"pairing_id": "ZZZZZZZZ"})
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"]})
    assert r.status_code == 410 and r.json()["error"]["code"] == "PAIRING_INVALIDATED"
    assert env.challenge()["pairing_id"]  # the owner can issue a fresh code


def test_device_self_revoke_and_owner_revoke(env):
    t1, d1 = env.pair("Phone 1")
    t2, d2 = env.pair("Phone 2")
    # A device cannot revoke another device.
    r = env.phone.post(f"/api/v1/devices/{d2['id']}/revoke", headers=auth(t1))
    assert r.status_code == 403
    # It can revoke itself (Disconnect in the app).
    assert env.phone.post(f"/api/v1/devices/{d1['id']}/revoke", headers=auth(t1)).status_code == 200
    assert env.phone.get("/api/v1/pairing/status", headers=auth(t1)).status_code == 401
    # The owner revokes from the laptop.
    assert env.owner.post(f"/api/v1/devices/{d2['id']}/revoke").status_code == 200
    assert env.phone.get("/api/v1/pairing/status", headers=auth(t2)).status_code == 401
    devices = env.owner.get("/api/v1/devices").json()["devices"]
    assert [d["revoked"] for d in devices] == [True, True]


def test_multiple_devices_have_independent_credentials(env):
    t1, _ = env.pair("A")
    t2, _ = env.pair("B")
    assert t1 != t2
    assert env.phone.get("/api/v1/pairing/status", headers=auth(t1)).json()["device"]["name"] == "A"
    assert env.phone.get("/api/v1/pairing/status", headers=auth(t2)).json()["device"]["name"] == "B"


def test_server_restart_keeps_credentials_and_revocations(tmp_path):
    env = Env(tmp_path)
    token, dev = env.pair()
    pending = env.challenge()
    revoked_token, revoked = env.pair("old")
    env.owner.post(f"/api/v1/devices/{revoked['id']}/revoke")
    server_id = env.services.store.server_id
    env.services.store.close()

    env2 = Env(tmp_path)  # same database file → simulated restart
    assert env2.services.store.server_id == server_id
    assert env2.phone.get("/api/v1/pairing/status", headers=auth(token)).status_code == 200
    assert env2.phone.get("/api/v1/pairing/status", headers=auth(revoked_token)).status_code == 401
    r = env2.phone.post("/api/v1/pairing/complete", json={"pairing_id": pending["pairing_id"]})
    assert r.status_code == 200  # unexpired challenge survives restart, still single-use


def test_invalid_host_header_is_rejected_dns_rebinding(env):
    evil = TestClient(env.app, base_url="http://attacker.example:5000", client=(PHONE_IP, 1))
    r = evil.get("/api/health")
    assert r.status_code == 421 and r.json()["error"]["code"] == "HOST_NOT_ALLOWED"


def test_cross_origin_requests_are_rejected(env):
    token, _ = env.pair()
    r = env.phone.get("/api/v1/items", headers={**auth(token), "Origin": "http://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"


def test_localhost_only_mode_rejects_lan_host(tmp_path):
    env = Env(tmp_path, lan_enabled=False, allowed_hosts={"localhost", "127.0.0.1", "::1"})
    assert env.owner.get("/api/health").status_code == 200
    assert env.phone.get("/api/health").status_code == 421


def test_oversized_json_is_rejected(env):
    token, _ = env.pair()
    big = "x" * (env.cfg.json_max_bytes + 10)
    r = env.phone.post("/api/v1/search", headers=auth(token), content=json.dumps({"query": big}),
                       )
    assert r.status_code == 413


def test_pairing_secrets_are_not_logged(env, capsys, caplog):
    ch = env.challenge()
    r = env.phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"]})
    token = r.json()["device_token"]
    out = capsys.readouterr()
    logs = caplog.text + out.out + out.err
    assert token not in logs and ch["pairing_id"] not in logs
