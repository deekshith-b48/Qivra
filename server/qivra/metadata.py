"""Lightweight, SSRF-guarded metadata fetch (title, description, preview image).

Only public http(s) hosts are fetched: a shared link must not be able to make
the laptop probe the user's LAN or loopback services.
"""

from __future__ import annotations

import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

MAX_BYTES = 1_000_000


class UnsafeUrlError(ValueError):
    pass


def assert_public_http_url(url: str) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise UnsafeUrlError("Only http(s) URLs can be fetched.")
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"Cannot resolve host: {p.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise UnsafeUrlError("Refusing to fetch a private or local network address.")


class _MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"].strip()

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and len(self.title) < 300:
            self.title += data


def parse_html_metadata(html: str, base_url: str) -> dict:
    p = _MetaParser()
    try:
        p.feed(html)
    except Exception:
        pass  # malformed HTML: keep whatever was parsed before the error
    m = p.meta
    image = m.get("og:image") or m.get("twitter:image") or ""
    return {
        "title": (m.get("og:title") or m.get("twitter:title") or p.title).strip()[:300],
        "description": (m.get("og:description") or m.get("description") or m.get("twitter:description") or "")[:1000],
        "siteName": m.get("og:site_name", "")[:120],
        "imageUrl": urljoin(base_url, image) if image else "",
        "author": m.get("author", "")[:120],
    }


def fetch_metadata(url: str, timeout: float = 10.0) -> dict:
    import httpx

    assert_public_http_url(url)
    current = url
    with httpx.Client(timeout=timeout, follow_redirects=False,
                      headers={"User-Agent": "Mozilla/5.0 (Qivra metadata fetcher)"}) as client:
        for _ in range(5):
            with client.stream("GET", current) as resp:
                if resp.is_redirect:
                    current = urljoin(current, resp.headers.get("location", ""))
                    assert_public_http_url(current)
                    continue
                resp.raise_for_status()
                ctype = resp.headers.get("content-type", "")
                if "html" not in ctype:
                    return {"title": "", "description": "", "siteName": "", "imageUrl": "", "author": "",
                            "contentType": ctype}
                buf = b""
                for chunk in resp.iter_bytes():
                    buf += chunk
                    if len(buf) > MAX_BYTES:
                        break
                html = buf.decode(resp.encoding or "utf-8", errors="replace")
                return {**parse_html_metadata(html, current), "finalUrl": current}
    raise UnsafeUrlError("Too many redirects.")
