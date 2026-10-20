"""Versioned Qivra API (`/api/health`, `/api/v1/...`).

Every route except /api/health and /api/v1/pairing/complete requires a paired
device credential (Authorization: Bearer qv1_...) or, for admin routes, an
owner request from loopback. Errors use {"error": {"code", "message"}}.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel, Field

from . import API_VERSION, PRODUCT, SERVER_VERSION, ai
from .jobs import JOB_KINDS
from .knowledge import agent_answer, build_report, terms_of
from .pairing import PairingError
from .security import ApiError, client_ip, device_from_request, is_owner_request
from .store import Device
from .transcripts import TranscriptParseError, find_passages, parse_transcript, segments_to_text
from .util import is_valid_entity_id, now_iso, sha256_hex

router = APIRouter()

MEDIA_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".flac", ".mp4", ".mov", ".webm", ".mkv",
                    ".3gp"}
LANG_RE = re.compile(r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$|^und$")


def services(request: Request):
    return request.app.state.qivra


def require_device(request: Request) -> Device:
    device = device_from_request(request)
    if device is None:
        token_present = bool(request.headers.get("authorization"))
        raise ApiError(401, "UNAUTHORIZED" if not token_present else "INVALID_CREDENTIAL",
                       "A valid paired-device credential is required." if not token_present else
                       "This device credential is invalid or was revoked. Pair again.")
    return device


def require_owner(request: Request) -> None:
    if not is_owner_request(request, services(request).config):
        raise ApiError(403, "OWNER_ONLY", "This action is only available on the server machine (localhost).")


def require_device_or_owner(request: Request) -> Device | None:
    if is_owner_request(request, services(request).config):
        return device_from_request(request)
    return require_device(request)


def _check_id(entity_id: str) -> str:
    if not is_valid_entity_id(entity_id):
        raise ApiError(400, "INVALID_ID", "Invalid id.")
    return entity_id


# ── health & pairing ─────────────────────────────────────────────────────────
@router.get("/api/health")
def health(request: Request) -> dict:
    svc = services(request)
    return {
        "status": "ok",
        "product": PRODUCT,
        "version": SERVER_VERSION,
        "api_version": API_VERSION,
        "server_id": svc.store.server_id,
        "time": now_iso(),
        "lan_enabled": svc.config.lan_enabled,
        "capabilities": ["pairing", "sync", "items", "transcripts", "jobs", "search", "agent", "reports", "media"],
    }


class ChallengeRequest(BaseModel):
    server_url: str | None = Field(default=None, max_length=200)


@router.post("/api/v1/pairing/challenges", dependencies=[Depends(require_owner)])
def create_challenge(request: Request, body: ChallengeRequest | None = None) -> dict:
    svc = services(request)
    url = body.server_url if body and body.server_url else None
    if url and url.rstrip("/") not in [u.rstrip("/") for u in svc.config.advertised_urls]:
        raise ApiError(400, "UNKNOWN_SERVER_URL", "server_url must be one of the server's advertised URLs.")
    return svc.pairing.create_challenge(url)


class PairingCompleteRequest(BaseModel):
    pairing_id: str = Field(min_length=4, max_length=20)
    device_name: str = Field(default="Android device", max_length=60)
    platform: str | None = Field(default="android", max_length=20)
    server_id: str | None = Field(default=None, max_length=40)


@router.post("/api/v1/pairing/complete")
def complete_pairing(request: Request, body: PairingCompleteRequest) -> dict:
    svc = services(request)
    if body.server_id and body.server_id != svc.store.server_id:
        raise ApiError(409, "WRONG_SERVER", "The QR code belongs to a different Qivra server.")
    try:
        device, token = svc.pairing.complete(body.pairing_id, body.device_name, body.platform, client_ip(request))
    except PairingError as exc:
        raise ApiError(exc.status, exc.code, exc.message) from exc
    return {
        "device": device.public(),
        "device_token": token,  # returned exactly once; only its hash is stored
        "server_id": svc.store.server_id,
        "server_time": now_iso(),
    }


@router.get("/api/v1/pairing/status")
def pairing_status(request: Request, device: Device = Depends(require_device)) -> dict:
    svc = services(request)
    return {
        "paired": True,
        "device": device.public(),
        "server": {"id": svc.store.server_id, "version": SERVER_VERSION, "lan_enabled": svc.config.lan_enabled},
        "server_time": now_iso(),
        "ai": ai.provider_status(),
    }


@router.get("/api/v1/devices")
def list_devices(request: Request, _: Device | None = Depends(require_device_or_owner)) -> dict:
    return {"devices": [d.public() for d in services(request).store.list_devices()]}


@router.post("/api/v1/devices/{device_id}/revoke")
def revoke_device(request: Request, device_id: str, caller: Device | None = Depends(require_device_or_owner)) -> dict:
    svc = services(request)
    owner = is_owner_request(request, svc.config)
    if not owner and (caller is None or caller.id != device_id):
        raise ApiError(403, "FORBIDDEN", "A device can only revoke itself; other devices are revoked on the server.")
    if svc.store.get_device(device_id) is None:
        raise ApiError(404, "NOT_FOUND", "Unknown device.")
    revoked = svc.store.revoke_device(device_id)
    return {"revoked": True, "already_revoked": not revoked, "device_id": device_id}


# ── items ────────────────────────────────────────────────────────────────────
class ItemIn(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    data: dict[str, Any]


class ItemPatch(BaseModel):
    base_revision: int | None = None
    patch: dict[str, Any]


def _validate_item_data(data: dict) -> dict:
    allowed = {"id", "sourceType", "url", "normalizedUrl", "title", "note", "summary", "keyPoints", "tags",
               "collectionIds", "language", "status", "createdAt", "capturedAt", "archived", "entities",
               "author", "enrichment", "metadata", "origin", "music", "userEdits", "thumbnailUrl"}
    unknown = set(data) - allowed
    if unknown:
        raise ApiError(400, "UNKNOWN_FIELDS", f"Unknown item fields: {', '.join(sorted(unknown))}")
    for key in ("title", "url", "note", "summary"):
        if key in data and data[key] is not None and not isinstance(data[key], str):
            raise ApiError(400, "INVALID_FIELD", f"{key} must be a string.")
    if "url" in data and data["url"] and not re.match(r"^https?://", str(data["url"])):
        raise ApiError(400, "INVALID_URL", "Only http(s) URLs can be stored as item URLs.")
    return data


@router.get("/api/v1/items")
def list_items(request: Request, after_seq: int = 0, limit: int = 100,
               _: Device | None = Depends(require_device_or_owner)) -> dict:
    limit = max(1, min(limit, 500))
    items = services(request).store.list_entities("item", after_seq=after_seq, limit=limit)
    return {"items": items, "next_after_seq": items[-1]["seq"] if items else after_seq}


@router.post("/api/v1/items", status_code=201)
def create_item(request: Request, body: ItemIn, device: Device = Depends(require_device)) -> dict:
    _check_id(body.id)
    data = _validate_item_data({**body.data, "id": body.id})
    status, ent = services(request).store.put_entity("item", body.id, data, base_revision=None, actor=device.id)
    if status == "conflict":
        # Idempotent create: same payload again is fine, different payload is a conflict.
        if ent and ent["data"] == data:
            return {"item": ent, "created": False}
        raise ApiError(409, "CONFLICT", "An item with this id already exists.", {"server": ent})
    return {"item": ent, "created": True}


@router.get("/api/v1/items/{item_id}")
def get_item(request: Request, item_id: str, _: Device | None = Depends(require_device_or_owner)) -> dict:
    ent = services(request).store.get_entity("item", _check_id(item_id))
    if ent is None or ent["deleted"]:
        raise ApiError(404, "NOT_FOUND", "Item not found.")
    return {"item": ent, "transcripts": [
        {k: v for k, v in t.items() if k != "segments"} | {"segment_count": len(t["segments"])}
        for t in services(request).store.list_transcripts(item_id)]}


@router.patch("/api/v1/items/{item_id}")
def patch_item(request: Request, item_id: str, body: ItemPatch, device: Device = Depends(require_device)) -> dict:
    _validate_item_data(body.patch)
    status, ent = services(request).store.patch_entity("item", _check_id(item_id), body.patch,
                                                      base_revision=body.base_revision, actor=device.id)
    if status == "missing":
        raise ApiError(404, "NOT_FOUND", "Item not found.")
    if status == "conflict":
        raise ApiError(409, "CONFLICT", "Item was modified elsewhere. Resolve the conflict and retry.",
                       {"server": ent})
    return {"item": ent}


@router.delete("/api/v1/items/{item_id}")
def delete_item(request: Request, item_id: str, base_revision: int | None = None,
                device: Device = Depends(require_device)) -> dict:
    store = services(request).store
    ent = store.get_entity("item", _check_id(item_id))
    if ent is None or ent["deleted"]:
        raise ApiError(404, "NOT_FOUND", "Item not found.")
    status, cur = store.put_entity("item", item_id, ent["data"], deleted=True,
                                   base_revision=base_revision if base_revision is not None else ent["revision"],
                                   actor=device.id)
    if status == "conflict":
        raise ApiError(409, "CONFLICT", "Item was modified elsewhere.", {"server": cur})
    return {"deleted": True, "item": cur}


# ── transcripts & media ──────────────────────────────────────────────────────
class TranscriptImport(BaseModel):
    text: str = Field(min_length=1, max_length=1_500_000)
    format: Literal["srt", "vtt", "txt"] | None = None
    filename: str | None = Field(default=None, max_length=200)
    language: str = Field(default="und", max_length=16)
    kind: Literal["original", "translation"] = "original"
    source: str = Field(default="user_import", max_length=40)


@router.post("/api/v1/items/{item_id}/transcripts/import")
def import_transcript(request: Request, item_id: str, body: TranscriptImport,
                      _: Device = Depends(require_device)) -> dict:
    store = services(request).store
    ent = store.get_entity("item", _check_id(item_id))
    if ent is None or ent["deleted"]:
        raise ApiError(404, "NOT_FOUND", "Item not found.")
    if not LANG_RE.match(body.language):
        raise ApiError(400, "INVALID_LANGUAGE", "Language must be a BCP-47 code like 'en' or 'pt-BR', or 'und'.")
    if not re.match(r"^[a-z0-9_]{1,40}$", body.source):
        raise ApiError(400, "INVALID_SOURCE", "Invalid transcript source label.")
    try:
        fmt, segments = parse_transcript(body.text, body.format, body.filename)
    except TranscriptParseError as exc:
        raise ApiError(422, "TRANSCRIPT_PARSE_ERROR", str(exc)) from exc
    tr = store.upsert_transcript(item_id, text=segments_to_text(segments), segments=segments,
                                 language=body.language, kind=body.kind, source=body.source, provider="import")
    return {"transcript": tr, "format": fmt}


@router.get("/api/v1/items/{item_id}/transcripts")
def get_transcripts(request: Request, item_id: str, _: Device | None = Depends(require_device_or_owner)) -> dict:
    return {"transcripts": services(request).store.list_transcripts(_check_id(item_id))}


@router.post("/api/v1/items/{item_id}/media")
async def upload_media(request: Request, item_id: str, file: UploadFile = File(...),
                       _: Device = Depends(require_device)) -> dict:
    svc = services(request)
    _check_id(item_id)
    ent = svc.store.get_entity("item", item_id)
    if ent is None or ent["deleted"]:
        raise ApiError(404, "NOT_FOUND", "Item not found.")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in MEDIA_EXTENSIONS:
        raise ApiError(415, "UNSUPPORTED_MEDIA", f"Unsupported file type '{ext or '?'}'.")
    # Never use the client filename on disk: a fixed directory + random name rules out traversal.
    target_dir = (svc.config.data_dir / "uploads" / item_id).resolve()
    uploads_root = (svc.config.data_dir / "uploads").resolve()
    if uploads_root not in target_dir.parents:
        raise ApiError(400, "INVALID_ID", "Invalid id.")
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{uuid.uuid4().hex}{ext}"
    size = 0
    try:
        with open(target, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > svc.config.upload_max_bytes:
                    raise ApiError(413, "PAYLOAD_TOO_LARGE",
                                   f"File exceeds {svc.config.upload_max_bytes // (1024 * 1024)} MB.")
                out.write(chunk)
    except ApiError:
        target.unlink(missing_ok=True)
        raise
    if size == 0:
        target.unlink(missing_ok=True)
        raise ApiError(400, "EMPTY_FILE", "Uploaded file is empty.")
    return {"media": svc.store.add_media(item_id, str(target), file.content_type, size)}


# ── jobs ─────────────────────────────────────────────────────────────────────
class ProcessRequest(BaseModel):
    kind: Literal["metadata", "captions", "transcribe", "enrich"]
    idempotency_key: str | None = Field(default=None, max_length=100)


@router.post("/api/v1/items/{item_id}/process", status_code=202)
def process_item(request: Request, item_id: str, body: ProcessRequest, device: Device = Depends(require_device)
                 ) -> dict:
    svc = services(request)
    ent = svc.store.get_entity("item", _check_id(item_id))
    if ent is None or ent["deleted"]:
        raise ApiError(404, "NOT_FOUND", "Item not found.")
    assert body.kind in JOB_KINDS
    key = body.idempotency_key or f"{item_id}:{body.kind}:{ent['revision']}"
    job_id = "job_" + sha256_hex(key)[:20]
    job, created = svc.store.create_job(job_id, item_id, body.kind, device.id)
    return {"job": job, "created": created}


@router.get("/api/v1/jobs/{job_id}")
def get_job(request: Request, job_id: str, _: Device | None = Depends(require_device_or_owner)) -> dict:
    job = services(request).store.get_job(_check_id(job_id))
    if job is None:
        raise ApiError(404, "NOT_FOUND", "Job not found.")
    return {"job": job}


@router.post("/api/v1/jobs/{job_id}/cancel")
def cancel_job(request: Request, job_id: str, _: Device = Depends(require_device)) -> dict:
    return {"cancelled": services(request).store.cancel_job(_check_id(job_id))}


# ── search, agent, reports ───────────────────────────────────────────────────
class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=20, ge=1, le=100)


@router.post("/api/v1/search")
def search(request: Request, body: SearchRequest, _: Device = Depends(require_device)) -> dict:
    store = services(request).store
    terms = terms_of(body.query)
    items = store.search_items(terms, limit=body.limit)
    passages = []
    for tr in store.search_transcripts(terms, limit=body.limit):
        for p in find_passages(tr, terms, max_passages=2):
            passages.append({"item_id": tr["item_id"], "transcript_id": tr["id"], "language": tr["language"], **p})
    return {"query": body.query, "terms": terms, "items": items, "passages": passages[: body.limit]}


class AgentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    timezone: str = Field(default="UTC", max_length=64)


@router.post("/api/v1/agent/messages")
def agent_message(request: Request, body: AgentRequest, _: Device = Depends(require_device)) -> dict:
    tz = _check_tz(body.timezone)
    return agent_answer(services(request).store, body.message, tz=tz)


class ReportRequest(BaseModel):
    kind: Literal["daily", "yesterday", "weekly", "range", "topic"] = "daily"
    timezone: str = Field(default="UTC", max_length=64)
    day: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    start: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    topic: str | None = Field(default=None, max_length=200)
    use_ai: bool = False


@router.post("/api/v1/reports", status_code=201)
def create_report(request: Request, body: ReportRequest, device: Device = Depends(require_device)) -> dict:
    tz = _check_tz(body.timezone)
    rep = build_report(services(request).store, kind=body.kind, tz=tz, day=body.day, start=body.start,
                       end=body.end, topic=body.topic, use_ai=body.use_ai, actor=device.id)
    return {"report": rep}


@router.get("/api/v1/reports")
def list_reports(request: Request, _: Device = Depends(require_device)) -> dict:
    return {"reports": services(request).store.list_reports()}


@router.get("/api/v1/reports/{report_id}")
def get_report(request: Request, report_id: str, _: Device = Depends(require_device)) -> dict:
    rep = services(request).store.get_report(_check_id(report_id))
    if rep is None:
        raise ApiError(404, "NOT_FOUND", "Report not found.")
    return {"report": rep}


@router.delete("/api/v1/reports/{report_id}")
def delete_report(request: Request, report_id: str, _: Device = Depends(require_device)) -> dict:
    if not services(request).store.delete_report(_check_id(report_id)):
        raise ApiError(404, "NOT_FOUND", "Report not found.")
    return {"deleted": True}


# ── sync ─────────────────────────────────────────────────────────────────────
class SyncChange(BaseModel):
    kind: Literal["item", "collection"] = "item"
    id: str = Field(min_length=1, max_length=80)
    base_revision: int | None = None
    deleted: bool = False
    data: dict[str, Any] = Field(default_factory=dict)


class SyncRequest(BaseModel):
    cursor: int = Field(default=0, ge=0)
    changes: list[SyncChange] = Field(default_factory=list, max_length=500)


@router.post("/api/v1/sync")
def sync(request: Request, body: SyncRequest, device: Device = Depends(require_device)) -> dict:
    """Push local changes and pull the server change feed.

    Each change carries the server revision it was based on. If the server copy
    moved on in the meantime the change is NOT applied; the server copy is
    returned in `conflicts` so the user can choose. Nothing is silently overwritten.
    """
    store = services(request).store
    applied, conflicts = [], []
    for ch in body.changes:
        _check_id(ch.id)
        data = _validate_item_data({**ch.data, "id": ch.id}) if ch.kind == "item" else _validate_collection(ch.data)
        status, ent = store.put_entity(ch.kind, ch.id, data, base_revision=ch.base_revision, deleted=ch.deleted,
                                       actor=device.id)
        if status == "applied":
            applied.append({"kind": ch.kind, "id": ch.id, "revision": ent["revision"] if ent else None,
                            "seq": ent["seq"] if ent else None})
        else:
            conflicts.append({"kind": ch.kind, "id": ch.id, "server": ent})
    changes = store.changes_since(body.cursor, limit=500)
    has_more = len(changes) == 500
    return {
        "applied": applied,
        "conflicts": conflicts,
        "changes": changes,
        "cursor": changes[-1]["seq"] if changes else max(body.cursor, 0),
        "has_more": has_more,
        "server_time": now_iso(),
    }


def _validate_collection(data: dict) -> dict:
    allowed = {"id", "name", "icon", "createdAt", "updatedAt", "description"}
    unknown = set(data) - allowed
    if unknown:
        raise ApiError(400, "UNKNOWN_FIELDS", f"Unknown collection fields: {', '.join(sorted(unknown))}")
    if not isinstance(data.get("name", ""), str) or len(data.get("name", "")) > 120:
        raise ApiError(400, "INVALID_FIELD", "Collection name must be a string up to 120 characters.")
    return data


def _check_tz(tz: str) -> str:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ApiError(400, "INVALID_TIMEZONE", "Unknown IANA timezone.") from exc
    return tz

