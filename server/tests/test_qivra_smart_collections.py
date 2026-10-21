"""Smart collections: the phone syncs a collection's `rules` along with its name."""

from qivra.store import QivraStore
from tests.helpers import auth

RULES = {"sourceTypes": ["youtube"], "concepts": ["vector search"], "savedWithinDays": 30, "unread": True}


def test_store_keeps_collection_rules_generically(tmp_path):
    store = QivraStore(tmp_path / "q.db")
    status, ent = store.put_entity("collection", "col_1", {"name": "Vectors", "icon": "sparkles", "rules": RULES},
                                   base_revision=None, actor="dev")
    assert status == "applied"
    assert ent["data"]["rules"] == RULES
    status, ent = store.put_entity("collection", "col_1", {"name": "Vectors", "icon": "sparkles", "rules": {"tags": ["rag"]}},
                                   base_revision=ent["revision"], actor="dev")
    assert status == "applied" and ent["data"]["rules"] == {"tags": ["rag"]}
    assert [c["data"].get("rules") for c in store.changes_since(0)] == [{"tags": ["rag"]}]
    store.close()


def test_sync_round_trips_smart_collection_rules(env):
    token, _ = env.pair()
    h = auth(token)
    r = env.phone.post("/api/v1/sync", headers=h, json={"cursor": 0, "changes": [
        {"kind": "collection", "id": "col_s", "data": {"name": "Vectors", "icon": "sparkles", "rules": RULES}}]})
    assert r.status_code == 200, r.text
    pulled = env.phone.post("/api/v1/sync", headers=h, json={"cursor": 0, "changes": []}).json()
    col = next(c for c in pulled["changes"] if c["kind"] == "collection")
    assert col["data"]["rules"] == RULES
    bad = env.phone.post("/api/v1/sync", headers=h, json={"cursor": 0, "changes": [
        {"kind": "collection", "id": "col_b", "data": {"name": "Bad", "rules": ["not", "an", "object"]}}]})
    assert bad.status_code == 400
