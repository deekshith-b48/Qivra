"""The legacy SuperBrain app with Qivra mounted: token scoping and no token disclosure."""

import pytest
from fastapi.testclient import TestClient

import api as legacy
from qivra.app import create_app
from tests.helpers import LAN_IP, PHONE_IP, auth, make_config


@pytest.fixture
def legacy_env(tmp_path):
    # api.app may already have served requests in another test module; allow re-mounting for this test.
    legacy.app.middleware_stack = None
    legacy.app.user_middleware = [m for m in legacy.app.user_middleware if "qivra" not in repr(m)]
    app = create_app(make_config(tmp_path), include_legacy=True)
    owner = TestClient(app, base_url="http://127.0.0.1:5000", client=("127.0.0.1", 1))
    phone = TestClient(app, base_url=f"http://{LAN_IP}:5000", client=(PHONE_IP, 2))
    return app, owner, phone


def test_connect_info_no_longer_discloses_the_token(legacy_env):
    _, owner, phone = legacy_env
    body = owner.get("/connect-info").json()
    assert legacy.API_TOKEN not in str(body) and "token" not in body


def test_legacy_token_is_loopback_only(legacy_env):
    _, owner, phone = legacy_env
    h = {"X-API-Key": legacy.API_TOKEN}
    assert owner.get("/queue-status", headers=h).status_code == 200
    assert phone.get("/queue-status", headers=h).status_code == 403
    assert phone.get("/queue-status", headers={"X-API-Key": "WRONG123"}).status_code == 401


def test_paired_device_can_use_legacy_routes(legacy_env):
    app, owner, phone = legacy_env
    ch = owner.post("/api/v1/pairing/challenges").json()
    token = phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"]}).json()["device_token"]
    assert phone.get("/queue-status", headers=auth(token)).status_code == 200
    assert phone.get("/api/health").json()["product"] == "Qivra"


def test_legacy_routes_get_host_validation(legacy_env):
    app, _, _ = legacy_env
    evil = TestClient(app, base_url="http://rebind.attacker.test:5000", client=(PHONE_IP, 3))
    assert evil.get("/ping").status_code == 421


def test_api_docs_are_not_served(legacy_env):
    _, owner, phone = legacy_env
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert owner.get(path).status_code == 404 and phone.get(path).status_code == 404
    assert phone.get("/api/health").headers["x-content-type-options"] == "nosniff"


def test_legacy_resets_only_from_the_laptop(legacy_env):
    _, owner, phone = legacy_env
    ch = owner.post("/api/v1/pairing/challenges").json()
    token = phone.post("/api/v1/pairing/complete", json={"pairing_id": ch["pairing_id"]}).json()["device_token"]
    # A wrong confirm word: even if the guard failed, nothing would be wiped.
    assert phone.post("/reset/database", headers=auth(token), json="NO").status_code == 403
    assert phone.post("/reset/api-token", headers=auth(token)).status_code == 403
    # On the laptop the guard lets it through to the confirmation check.
    assert owner.post("/reset/database", headers={"X-API-Key": legacy.API_TOKEN}, json="NO").status_code == 400
