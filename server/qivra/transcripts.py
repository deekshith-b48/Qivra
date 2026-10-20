"""Transcript parsing (SRT, WebVTT, plain text) and passage search.

Mirrors `src/core/transcripts.ts` in the Android app so both sides produce the
same segments for the same input. Timestamps are kept only when the source
provides them — nothing is synthesised.
"""

from __future__ import annotations

import html
import re

_TS = r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})"
_CUE_RE = re.compile(rf"^\s*{_TS}\s*-->\s*{_TS}")
_CUE_ANYWHERE_RE = re.compile(rf"^\s*{_TS}\s*-->\s*{_TS}", re.MULTILINE)
_INLINE_TS_RE = re.compile(r"^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–:]?\s+(.*)$")
_TAG_RE = re.compile(r"<[^>]+>")

MAX_TRANSCRIPT_CHARS = 1_500_000


class TranscriptParseError(ValueError):
    pass


def _ms(h, m, s, frac) -> int:
    frac = (frac or "0").ljust(3, "0")[:3]
    return ((int(h or 0) * 60 + int(m)) * 60 + int(s)) * 1000 + int(frac)


def _clean(line: str) -> str:
    return html.unescape(_TAG_RE.sub("", line)).strip()


def _parse_cues(text: str) -> list[dict]:
    segments: list[dict] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines):
        m = _CUE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        g = m.groups()
        start, end = _ms(*g[0:4]), _ms(*g[4:8])
        i += 1
        body: list[str] = []
        while i < len(lines) and lines[i].strip() != "":
            if _CUE_RE.match(lines[i]):
                break
            cleaned = _clean(lines[i])
            if cleaned:
                body.append(cleaned)
            i += 1
        txt = " ".join(body).strip()
        if txt:
            # Collapse rolling-caption duplicates (common in auto captions).
            if segments and segments[-1]["text"] == txt:
                segments[-1]["end_ms"] = max(segments[-1]["end_ms"], end)
            else:
                segments.append({"start_ms": start, "end_ms": max(end, start), "text": txt})
    return segments


def parse_srt(text: str) -> list[dict]:
    segs = _parse_cues(text)
    if not segs:
        raise TranscriptParseError("No SRT cues found.")
    return segs


def parse_vtt(text: str) -> list[dict]:
    if not text.lstrip("﻿").lstrip().startswith("WEBVTT"):
        raise TranscriptParseError("Missing WEBVTT header.")
    segs = _parse_cues(text)
    if not segs:
        raise TranscriptParseError("No WebVTT cues found.")
    return segs


def parse_txt(text: str) -> list[dict]:
    """Plain text. Lines like '[01:02] text' or '1:02:03 text' keep their timestamps."""
    segs: list[dict] = []
    plain: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = _INLINE_TS_RE.match(line)
        if m:
            parts = [int(p) for p in m.group(1).split(":")]
            while len(parts) < 3:
                parts.insert(0, 0)
            start = ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000
            if segs and segs[-1]["end_ms"] is None:
                segs[-1]["end_ms"] = start
            segs.append({"start_ms": start, "end_ms": None, "text": m.group(2).strip()})
        else:
            plain.append(line)
    if segs and len(segs) >= max(2, len(plain)):
        if segs[-1]["end_ms"] is None:
            segs[-1]["end_ms"] = segs[-1]["start_ms"]
        return segs
    joined = "\n".join(plain if not segs else [s["text"] for s in segs] + plain).strip()
    if not joined:
        raise TranscriptParseError("Transcript is empty.")
    return [{"start_ms": None, "end_ms": None, "text": joined}]


def detect_format(filename: str | None, text: str) -> str:
    name = (filename or "").lower()
    if name.endswith(".vtt") or text.lstrip("﻿").lstrip().startswith("WEBVTT"):
        return "vtt"
    if name.endswith(".srt") or _CUE_ANYWHERE_RE.search(text[:2000]):
        return "srt"
    return "txt"


def parse_transcript(text: str, fmt: str | None = None, filename: str | None = None) -> tuple[str, list[dict]]:
    if len(text) > MAX_TRANSCRIPT_CHARS:
        raise TranscriptParseError(f"Transcript too large (max {MAX_TRANSCRIPT_CHARS} characters).")
    text = text.lstrip("﻿")
    fmt = (fmt or detect_format(filename, text)).lower()
    if fmt == "srt":
        return fmt, parse_srt(text)
    if fmt == "vtt":
        return fmt, parse_vtt(text)
    if fmt == "txt":
        return fmt, parse_txt(text)
    raise TranscriptParseError(f"Unsupported transcript format: {fmt}")


def segments_to_text(segments: list[dict]) -> str:
    return "\n".join(s["text"] for s in segments)


def find_passages(transcript: dict, terms: list[str], max_passages: int = 3, window: int = 1) -> list[dict]:
    """Return short passages (with timestamps when available) that mention any term."""
    segs = transcript.get("segments") or []
    if not segs:
        segs = [{"start_ms": None, "end_ms": None, "text": transcript.get("text", "")}]
    hits: list[dict] = []
    for idx, seg in enumerate(segs):
        low = seg["text"].lower()
        if any(t in low for t in terms):
            lo, hi = max(0, idx - window), min(len(segs), idx + window + 1)
            text = " ".join(s["text"] for s in segs[lo:hi])
            if len(segs) == 1:
                pos = min((low.find(t) for t in terms if t in low), default=0)
                text = seg["text"][max(0, pos - 200): pos + 300]
            hits.append({"start_ms": segs[lo].get("start_ms"), "text": text.strip()})
            if len(hits) >= max_passages:
                break
    return hits


def format_ts(ms: int | None) -> str:
    if ms is None:
        return ""
    s = ms // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"
