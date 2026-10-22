"""SQLite persistence for the Qivra API.

Tables live next to SuperBrain's `analyses` table in the same database file
(prefixed `qv_`) so existing SuperBrain data can be mirrored without copying
files around. Migrations are additive and versioned via `qv_meta.schema_version`;
nothing here drops or rewrites SuperBrain tables.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import new_id, now_iso, sha256_hex

SCHEMA_VERSION = 1

_MIGRATIONS: dict[int, str] = {
    1: """
    CREATE TABLE IF NOT EXISTS qv_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- Generic synchronised entities (kind = 'item' | 'collection').
    -- revision: per-entity optimistic-concurrency counter.
    -- seq:      global change-feed position (monotonic).
    CREATE TABLE IF NOT EXISTS qv_entities (
        kind        TEXT NOT NULL,
        id          TEXT NOT NULL,
        owner       TEXT NOT NULL DEFAULT 'local',
        revision    INTEGER NOT NULL,
        seq         INTEGER NOT NULL,
        deleted     INTEGER NOT NULL DEFAULT 0,
        data_json   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT,
        legacy_ref  TEXT,
        PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_qv_entities_seq ON qv_entities (seq);
    CREATE INDEX IF NOT EXISTS idx_qv_entities_legacy ON qv_entities (legacy_ref);

    CREATE TABLE IF NOT EXISTS qv_devices (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        platform      TEXT,
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT,
        last_ip       TEXT,
        revoked_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS qv_pairing (
        code_hash   TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT,
        device_id   TEXT,
        invalidated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS qv_transcripts (
        id            TEXT PRIMARY KEY,
        item_id       TEXT NOT NULL,
        language      TEXT NOT NULL DEFAULT 'und',
        kind          TEXT NOT NULL DEFAULT 'original',
        source        TEXT NOT NULL,
        provider      TEXT,
        text          TEXT NOT NULL,
        segments_json TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (item_id, language, kind, source)
    );
    CREATE INDEX IF NOT EXISTS idx_qv_transcripts_item ON qv_transcripts (item_id);

    CREATE TABLE IF NOT EXISTS qv_jobs (
        id            TEXT PRIMARY KEY,
        item_id       TEXT NOT NULL,
        kind          TEXT NOT NULL,
        status        TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        error_code    TEXT,
        error_message TEXT,
        result_json   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        created_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_qv_jobs_status ON qv_jobs (status, created_at);

    CREATE TABLE IF NOT EXISTS qv_reports (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        kind        TEXT NOT NULL,
        range_start TEXT NOT NULL,
        range_end   TEXT NOT NULL,
        timezone    TEXT NOT NULL,
        markdown    TEXT NOT NULL,
        provider    TEXT,
        created_at  TEXT NOT NULL,
        created_by  TEXT
    );

    CREATE TABLE IF NOT EXISTS qv_media (
        id          TEXT PRIMARY KEY,
        item_id     TEXT NOT NULL,
        path        TEXT NOT NULL,
        mime        TEXT,
        size_bytes  INTEGER NOT NULL,
        created_at  TEXT NOT NULL
    );
    """,
}


@dataclass
class Device:
    id: str
    name: str
    platform: str | None
    created_at: str
    last_seen_at: str | None
    last_ip: str | None
    revoked_at: str | None

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "platform": self.platform,
            "created_at": self.created_at,
            "last_seen_at": self.last_seen_at,
            "revoked": self.revoked_at is not None,
            "revoked_at": self.revoked_at,
        }


class QivraStore:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._migrate()
        self._purge_deleted_items()

    # ── schema ────────────────────────────────────────────────────────────
    def _migrate(self) -> None:
        with self._lock:
            self._conn.execute("CREATE TABLE IF NOT EXISTS qv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            row = self._conn.execute("SELECT value FROM qv_meta WHERE key='schema_version'").fetchone()
            current = int(row["value"]) if row else 0
            for version in sorted(v for v in _MIGRATIONS if v > current):
                with self._conn:
                    self._conn.executescript(_MIGRATIONS[version])
                    self._conn.execute(
                        "INSERT INTO qv_meta(key, value) VALUES('schema_version', ?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (str(version),),
                    )
            if self.get_meta("server_id") is None:
                self.set_meta("server_id", new_id())
            if self.get_meta("seq") is None:
                self.set_meta("seq", "0")

    def schema_version(self) -> int:
        return int(self.get_meta("schema_version") or 0)

    def get_meta(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value FROM qv_meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO qv_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    @property
    def server_id(self) -> str:
        return self.get_meta("server_id") or ""

    def _next_seq(self) -> int:
        seq = int(self.get_meta("seq") or 0) + 1
        self._conn.execute("UPDATE qv_meta SET value=? WHERE key='seq'", (str(seq),))
        return seq

    def current_seq(self) -> int:
        return int(self.get_meta("seq") or 0)

    # ── entities ──────────────────────────────────────────────────────────
    @staticmethod
    def _entity_row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        return {
            "kind": row["kind"],
            "id": row["id"],
            "revision": row["revision"],
            "seq": row["seq"],
            "deleted": bool(row["deleted"]),
            "data": json.loads(row["data_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "updated_by": row["updated_by"],
        }

    def get_entity(self, kind: str, entity_id: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM qv_entities WHERE kind=? AND id=?", (kind, entity_id)).fetchone()
        return self._entity_row(row)

    def list_entities(self, kind: str, *, include_deleted: bool = False, limit: int = 100,
                      after_seq: int = 0) -> list[dict]:
        sql = "SELECT * FROM qv_entities WHERE kind=? AND seq>?"
        if not include_deleted:
            sql += " AND deleted=0"
        sql += " ORDER BY seq ASC LIMIT ?"
        return [self._entity_row(r) for r in self._conn.execute(sql, (kind, after_seq, limit))]

    def changes_since(self, after_seq: int, limit: int = 500) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM qv_entities WHERE seq>? ORDER BY seq ASC LIMIT ?", (after_seq, limit)
        )
        return [self._entity_row(r) for r in rows]

    def put_entity(self, kind: str, entity_id: str, data: dict, *, base_revision: int | None,
                   deleted: bool = False, actor: str | None = None,
                   legacy_ref: str | None = None) -> tuple[str, dict | None]:
        """Optimistic-concurrency write.

        Returns ("applied", entity) or ("conflict", current_server_entity).
        base_revision None/0 means "create"; it conflicts if the entity exists.
        """
        media: list[str] = []
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT * FROM qv_entities WHERE kind=? AND id=?", (kind, entity_id)
            ).fetchone()
            now = now_iso()
            if row is None:
                if deleted:
                    return "applied", None
                seq = self._next_seq()
                self._conn.execute(
                    "INSERT INTO qv_entities(kind, id, revision, seq, deleted, data_json, created_at, "
                    "updated_at, updated_by, legacy_ref) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (kind, entity_id, 1, seq, 0, json.dumps(data), now, now, actor, legacy_ref),
                )
            else:
                if (base_revision or 0) != row["revision"]:
                    return "conflict", self._entity_row(row)
                seq = self._next_seq()
                self._conn.execute(
                    "UPDATE qv_entities SET revision=revision+1, seq=?, deleted=?, data_json=?, "
                    "updated_at=?, updated_by=? WHERE kind=? AND id=?",
                    # A tombstone keeps no content: devices only need to know the entity is gone.
                    (seq, 1 if deleted else 0, json.dumps({} if deleted else data), now, actor, kind, entity_id),
                )
                if deleted and kind == "item":
                    media = self._purge_item_content(entity_id)
        for path in media:  # only after the commit, so a failed write never loses files
            Path(path).unlink(missing_ok=True)
        return "applied", self.get_entity(kind, entity_id)

    def _purge_deleted_items(self) -> None:
        """Clean up items deleted before tombstones were emptied on delete (runs at startup, cheap when clean)."""
        media: list[str] = []
        with self._lock, self._conn:
            ids = [r["id"] for r in self._conn.execute(
                "SELECT id FROM qv_entities WHERE kind='item' AND deleted=1 AND (data_json != '{}' "
                "OR id IN (SELECT item_id FROM qv_transcripts) OR id IN (SELECT item_id FROM qv_media))")]
            for item_id in ids:
                media += self._purge_item_content(item_id)
            self._conn.execute("UPDATE qv_entities SET data_json='{}' WHERE deleted=1 AND data_json != '{}'")
        for path in media:
            Path(path).unlink(missing_ok=True)

    def _purge_item_content(self, item_id: str) -> list[str]:
        """A deleted item's transcripts and uploads go too; returns the upload paths to remove from disk."""
        paths = [r["path"] for r in self._conn.execute("SELECT path FROM qv_media WHERE item_id=?", (item_id,))]
        self._conn.execute("DELETE FROM qv_media WHERE item_id=?", (item_id,))
        self._conn.execute("DELETE FROM qv_transcripts WHERE item_id=?", (item_id,))
        return paths

    def patch_entity(self, kind: str, entity_id: str, patch: dict, *, base_revision: int | None,
                     actor: str | None) -> tuple[str, dict | None]:
        current = self.get_entity(kind, entity_id)
        if current is None or current["deleted"]:
            return "missing", None
        if base_revision is None:
            base_revision = current["revision"]
        merged = {**current["data"], **patch}
        return self.put_entity(kind, entity_id, merged, base_revision=base_revision, actor=actor)

    def server_update_item(self, entity_id: str, patch: dict, actor: str = "server") -> dict | None:
        """Server-side processing result: always merges on top of the latest revision."""
        with self._lock:
            current = self.get_entity("item", entity_id)
            if current is None:
                return None
            status, ent = self.put_entity("item", entity_id, {**current["data"], **patch},
                                          base_revision=current["revision"], actor=actor)
            return ent if status == "applied" else None

    def search_items(self, terms: list[str], limit: int = 20) -> list[dict]:
        if not terms:
            return []
        rows = self._conn.execute("SELECT * FROM qv_entities WHERE kind='item' AND deleted=0").fetchall()
        scored: list[tuple[float, dict]] = []
        for row in rows:
            ent = self._entity_row(row)
            d = ent["data"]
            hay_title = str(d.get("title") or "").lower()
            hay = " ".join(
                str(x) for x in [d.get("title"), d.get("summary"), d.get("note"), d.get("url"),
                                 " ".join(d.get("tags") or []), " ".join(d.get("keyPoints") or [])]
                if x
            ).lower()
            score = 0.0
            for t in terms:
                if t in hay_title:
                    score += 3
                score += hay.count(t)
            if score:
                scored.append((score, ent))
        scored.sort(key=lambda s: -s[0])
        return [e for _, e in scored[:limit]]

    # ── legacy SuperBrain mirror ─────────────────────────────────────────
    def mirror_legacy_analyses(self) -> int:
        """Copy SuperBrain `analyses` rows into Qivra items (idempotent, additive).

        Existing Qivra items that came from the mirror are refreshed only when the
        SuperBrain row is newer and no device has edited the item since.
        """
        try:
            rows = self._conn.execute(
                "SELECT shortcode, url, username, content_type, analyzed_at, updated_at, title, summary, "
                "tags, category, music, audio_transcription, COALESCE(is_hidden,0) AS is_hidden FROM analyses"
            ).fetchall()
        except sqlite3.OperationalError:
            return 0  # SuperBrain table not present (fresh install)
        mirrored = 0
        for r in rows:
            item_id = "sb_" + "".join(c if c.isalnum() or c in "_-" else "_" for c in r["shortcode"])[:70]
            try:
                tags = json.loads(r["tags"] or "[]")
            except (TypeError, ValueError):
                tags = []
            if r["category"] and r["category"] not in tags:
                tags.append(r["category"])
            source = {"instagram": "instagram", "youtube": "youtube"}.get(r["content_type"] or "", "web")
            data = {
                "id": item_id,
                "sourceType": source,
                "url": r["url"] or "",
                "title": r["title"] or "",
                "summary": r["summary"] or "",
                "author": r["username"] or "",
                "tags": tags,
                "note": "",
                "keyPoints": [],
                "collectionIds": [],
                "archived": False,
                "status": "READY" if (r["summary"] or r["title"]) else "CAPTURED",
                "createdAt": _legacy_ts(r["analyzed_at"]),
                "capturedAt": _legacy_ts(r["analyzed_at"]),
                "origin": "superbrain",
                "music": r["music"] or "",
            }
            existing = self.get_entity("item", item_id)
            if existing is None:
                self.put_entity("item", item_id, data, base_revision=None, actor="superbrain",
                                deleted=False, legacy_ref=r["shortcode"])
                if r["is_hidden"]:
                    ent = self.get_entity("item", item_id)
                    self.put_entity("item", item_id, data, base_revision=ent["revision"], deleted=True,
                                    actor="superbrain")
                mirrored += 1
            elif existing["updated_by"] == "superbrain" and (r["updated_at"] or "") > existing["updated_at"].rstrip("Z"):
                self.put_entity("item", item_id, data, base_revision=existing["revision"],
                                deleted=bool(r["is_hidden"]), actor="superbrain")
                mirrored += 1
            current = self.get_entity("item", item_id)
            if r["audio_transcription"] and r["audio_transcription"].strip() and current and not current["deleted"]:
                self.upsert_transcript(item_id, text=r["audio_transcription"].strip(), segments=[],
                                       language="und", kind="original", source="superbrain_audio",
                                       provider="superbrain")
        return mirrored

    # ── transcripts ───────────────────────────────────────────────────────
    def upsert_transcript(self, item_id: str, *, text: str, segments: list[dict], language: str,
                          kind: str, source: str, provider: str | None) -> dict:
        """Idempotent on (item_id, language, kind, source): retries never duplicate."""
        now = now_iso()
        tid = "tr_" + sha256_hex(f"{item_id}|{language}|{kind}|{source}")[:16]
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO qv_transcripts(id, item_id, language, kind, source, provider, text, segments_json, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(item_id, language, kind, source) DO UPDATE SET text=excluded.text, "
                "segments_json=excluded.segments_json, provider=excluded.provider, updated_at=excluded.updated_at",
                (tid, item_id, language, kind, source, provider, text, json.dumps(segments), now, now),
            )
        return self.get_transcript(tid)

    def get_transcript(self, transcript_id: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM qv_transcripts WHERE id=?", (transcript_id,)).fetchone()
        return _transcript_row(row)

    def list_transcripts(self, item_id: str) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM qv_transcripts WHERE item_id=? ORDER BY kind, language", (item_id,)
        )
        return [_transcript_row(r) for r in rows]

    def search_transcripts(self, terms: list[str], limit: int = 40) -> list[dict]:
        if not terms:
            return []
        clause = " OR ".join("LOWER(text) LIKE ? ESCAPE '\\'" for _ in terms)
        # Escape LIKE wildcards so a search for "100%" means the text "100%".
        like = ["%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for t in terms]
        rows = self._conn.execute(f"SELECT * FROM qv_transcripts WHERE {clause} LIMIT ?", like + [limit])
        return [_transcript_row(r) for r in rows]

    # ── devices & pairing ────────────────────────────────────────────────
    def create_pairing(self, code: str, expires_at: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO qv_pairing(code_hash, created_at, expires_at) VALUES (?,?,?)",
                (sha256_hex(code), now_iso(), expires_at),
            )

    def get_pairing(self, code: str) -> sqlite3.Row | None:
        return self._conn.execute("SELECT * FROM qv_pairing WHERE code_hash=?", (sha256_hex(code),)).fetchone()

    def consume_pairing(self, code: str, now: str) -> bool:
        """Atomically mark a challenge used. False if unknown, expired, used or invalidated."""
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE qv_pairing SET used_at=? WHERE code_hash=? AND used_at IS NULL AND invalidated=0 "
                "AND expires_at>?",
                (now, sha256_hex(code), now),
            )
            return cur.rowcount == 1

    def attach_pairing_device(self, code: str, device_id: str) -> None:
        with self._lock, self._conn:
            self._conn.execute("UPDATE qv_pairing SET device_id=? WHERE code_hash=?", (device_id, sha256_hex(code)))

    def invalidate_active_pairings(self) -> int:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE qv_pairing SET invalidated=1 WHERE used_at IS NULL AND invalidated=0"
            )
            return cur.rowcount

    def active_pairing_count(self, now: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) AS n FROM qv_pairing WHERE used_at IS NULL AND invalidated=0 AND expires_at>?",
            (now,),
        ).fetchone()
        return int(row["n"])

    def create_device(self, name: str, platform: str | None, token: str, ip: str | None) -> Device:
        device_id = new_id("dev_")
        now = now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO qv_devices(id, name, platform, token_hash, created_at, last_seen_at, last_ip) "
                "VALUES (?,?,?,?,?,?,?)",
                (device_id, name, platform, sha256_hex(token), now, now, ip),
            )
        return self.get_device(device_id)  # type: ignore[return-value]

    def get_device(self, device_id: str) -> Device | None:
        row = self._conn.execute("SELECT * FROM qv_devices WHERE id=?", (device_id,)).fetchone()
        return _device_row(row)

    def device_by_token(self, token: str) -> Device | None:
        row = self._conn.execute("SELECT * FROM qv_devices WHERE token_hash=?", (sha256_hex(token),)).fetchone()
        return _device_row(row)

    def touch_device(self, device_id: str, ip: str | None) -> None:
        with self._lock, self._conn:
            self._conn.execute("UPDATE qv_devices SET last_seen_at=?, last_ip=? WHERE id=?",
                               (now_iso(), ip, device_id))

    def list_devices(self) -> list[Device]:
        return [_device_row(r) for r in self._conn.execute("SELECT * FROM qv_devices ORDER BY created_at")]  # type: ignore[misc]

    def revoke_device(self, device_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE qv_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (now_iso(), device_id)
            )
            return cur.rowcount == 1

    # ── jobs ──────────────────────────────────────────────────────────────
    def create_job(self, job_id: str, item_id: str, kind: str, actor: str | None) -> tuple[dict, bool]:
        """Idempotent: an existing job with the same id is returned unchanged unless it failed retryably."""
        with self._lock, self._conn:
            existing = self.get_job(job_id)
            if existing is not None:
                if existing["status"] in ("failed_retryable", "cancelled"):
                    self._conn.execute(
                        "UPDATE qv_jobs SET status='queued', error_code=NULL, error_message=NULL, updated_at=? "
                        "WHERE id=?", (now_iso(), job_id))
                    return self.get_job(job_id), True  # type: ignore[return-value]
                return existing, False
            now = now_iso()
            self._conn.execute(
                "INSERT INTO qv_jobs(id, item_id, kind, status, created_at, updated_at, created_by) "
                "VALUES (?,?,?,?,?,?,?)",
                (job_id, item_id, kind, "queued", now, now, actor),
            )
        return self.get_job(job_id), True  # type: ignore[return-value]

    def get_job(self, job_id: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM qv_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            return None
        d = dict(row)
        d["result"] = json.loads(d.pop("result_json") or "null")
        return d

    def next_queued_job(self) -> dict | None:
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT id FROM qv_jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            self._conn.execute(
                "UPDATE qv_jobs SET status='running', attempts=attempts+1, updated_at=? WHERE id=?",
                (now_iso(), row["id"]),
            )
        return self.get_job(row["id"])

    def finish_job(self, job_id: str, status: str, *, result: Any = None, error_code: str | None = None,
                   error_message: str | None = None) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE qv_jobs SET status=?, result_json=?, error_code=?, error_message=?, updated_at=? "
                "WHERE id=? AND status!='cancelled'",
                (status, json.dumps(result) if result is not None else None, error_code, error_message,
                 now_iso(), job_id),
            )

    def cancel_job(self, job_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE qv_jobs SET status='cancelled', updated_at=? WHERE id=? AND status IN ('queued','running')",
                (now_iso(), job_id),
            )
            return cur.rowcount == 1

    def recover_running_jobs(self) -> int:
        """After a restart, jobs left 'running' are re-queued (process died mid-job)."""
        with self._lock, self._conn:
            cur = self._conn.execute(
                "UPDATE qv_jobs SET status='queued', updated_at=? WHERE status='running'", (now_iso(),)
            )
            return cur.rowcount

    # ── media ─────────────────────────────────────────────────────────────
    def add_media(self, item_id: str, path: str, mime: str | None, size: int) -> dict:
        mid = new_id("med_")
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO qv_media(id, item_id, path, mime, size_bytes, created_at) VALUES (?,?,?,?,?,?)",
                (mid, item_id, path, mime, size, now_iso()),
            )
        return {"id": mid, "item_id": item_id, "mime": mime, "size_bytes": size}

    def latest_media(self, item_id: str) -> dict | None:
        row = self._conn.execute(
            "SELECT * FROM qv_media WHERE item_id=? ORDER BY created_at DESC LIMIT 1", (item_id,)
        ).fetchone()
        return dict(row) if row else None

    # ── reports ───────────────────────────────────────────────────────────
    def save_report(self, report: dict) -> dict:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO qv_reports(id, title, kind, range_start, range_end, timezone, markdown, provider, "
                "created_at, created_by) VALUES (:id,:title,:kind,:range_start,:range_end,:timezone,:markdown,"
                ":provider,:created_at,:created_by)",
                report,
            )
        return report

    def list_reports(self, limit: int = 50) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, title, kind, range_start, range_end, timezone, provider, created_at FROM qv_reports "
            "ORDER BY created_at DESC LIMIT ?", (limit,))
        return [dict(r) for r in rows]

    def get_report(self, report_id: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM qv_reports WHERE id=?", (report_id,)).fetchone()
        return dict(row) if row else None

    def delete_report(self, report_id: str) -> bool:
        with self._lock, self._conn:
            return self._conn.execute("DELETE FROM qv_reports WHERE id=?", (report_id,)).rowcount == 1

    def items_in_range(self, start_iso: str, end_iso: str) -> list[dict]:
        out = []
        for ent in self.list_entities("item", limit=100000):
            created = (ent["data"].get("capturedAt") or ent["data"].get("createdAt") or ent["created_at"])
            if start_iso <= created < end_iso:
                out.append(ent)
        return out

    def close(self) -> None:
        self._conn.close()


def _legacy_ts(value: str | None) -> str:
    if not value:
        return now_iso()
    v = value.strip()
    if not v.endswith("Z") and "+" not in v[10:]:
        v = v[:23] + "Z"
    return v


def _transcript_row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    d["segments"] = json.loads(d.pop("segments_json") or "[]")
    return d


def _device_row(row: sqlite3.Row | None) -> Device | None:
    if row is None:
        return None
    return Device(
        id=row["id"], name=row["name"], platform=row["platform"], created_at=row["created_at"],
        last_seen_at=row["last_seen_at"], last_ip=row["last_ip"], revoked_at=row["revoked_at"],
    )

