import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from qivra.app import create_app  # noqa: E402
from qivra.config import QivraConfig  # noqa: E402

LAN_IP = "192.168.1.50"
PHONE_IP = "192.168.1.77"


def make_config(tmp_path: Path, **overrides) -> QivraConfig:
    cfg = QivraConfig(
        db_path=tmp_path / "test.db",
        data_dir=tmp_path / "data",
        lan_enabled=True,
        port=5000,
        start_job_worker=False,
    )
    cfg.allowed_hosts |= {LAN_IP}
    cfg.advertised_urls = [f"http://{LAN_IP}:5000"]
    for k, v in overrides.items():
        setattr(cfg, k, v)
    return cfg


class Env:
    def __init__(self, tmp_path: Path, **overrides):
        self.tmp_path = tmp_path
        self.cfg = make_config(tmp_path, **overrides)
        self.app = create_app(self.cfg, include_legacy=False)
        self.services = self.app.state.qivra
        # The laptop owner: loopback client + loopback Host header.
        self.owner = TestClient(self.app, base_url="http://127.0.0.1:5000", client=("127.0.0.1", 40000))
        # A phone on the LAN talking to the LAN address.
        self.phone = TestClient(self.app, base_url=f"http://{LAN_IP}:5000", client=(PHONE_IP, 40001))

    def challenge(self) -> dict:
        r = self.owner.post("/api/v1/pairing/challenges")
        assert r.status_code == 200, r.text
        return r.json()

    def pair(self, name: str = "Pixel 8", client: TestClient | None = None) -> tuple[str, dict]:
        ch = self.challenge()
        r = (client or self.phone).post("/api/v1/pairing/complete",
                                        json={"pairing_id": ch["pairing_id"], "device_name": name,
                                              "server_id": ch["server_id"]})
        assert r.status_code == 200, r.text
        body = r.json()
        return body["device_token"], body["device"]


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}

