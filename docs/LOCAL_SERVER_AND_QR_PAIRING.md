# Local server, access ID and QR pairing

## Start

```bash
cd server
.venv/bin/python -m qivra serve          # this machine only (127.0.0.1)
.venv/bin/python -m qivra serve --lan    # also phones on the same Wi-Fi (+ Tailscale/WireGuard if present)
.venv/bin/python -m qivra serve --remote # like --lan, but the QR prefers the private-VPN address
```

Other commands (talk to a running server over loopback): `python -m qivra pair --port N` (new code), `python -m qivra devices --port N`, `python -m qivra revoke <device_id> --port N`. In the serve terminal: Enter = new code, `d` = devices, `q` = quit.

Startup sequence: choose port (5000, or the next free one — never kills other processes) → mount Qivra on the SuperBrain app → mirror SuperBrain data → start uvicorn → **health-check `http://127.0.0.1:<port>/api/health`** → only then print URLs → in `--lan` mode detect private IPv4 addresses and probe each LAN URL from the machine itself → print security status → create a pairing challenge and print the Access ID and QR. Example of real output (2026-10-21, this machine):

```
QIVRA LOCAL SERVER  v1.0.0 · SuperBrain backend
  Port 5000 is in use (on macOS often AirPlay Receiver); using 5001 instead.
Status: Running (health check passed)
Local
  http://127.0.0.1:5001   (API docs: http://127.0.0.1:5001/docs)
Server (LAN)
  http://10.109.230.239:5001   (reachable from this machine)
Security
  Local-network pairing: enabled
  Public exposure: disabled (no tunnels are started)
  Transport: HTTP — not encrypted in transit; use only on a trusted network
Pairing
  Server URL : http://10.109.230.239:5001
  Access ID  : CCWW-5HVZ  (one-time, expires …, ~5 min)
```

"Reachable from this machine" proves the socket is bound on that address; it cannot prove the phone's network path (firewall, router client isolation).

HTTPS: `--tls-cert cert.pem --tls-key key.pem`. Only certificates the phone already trusts through the system store work (Qivra trusts system CAs only), e.g. a certificate for a hostname you own or a Tailscale HTTPS certificate.

## QR payload (version 1)

```json
{"version":1,"product":"Qivra","server_url":"http://10.109.230.239:5001",
 "server_id":"90726e5714364abe","pairing_id":"CCWW5HVZ","expires_at":"2026-10-20T20:36:39.048Z",
 "alt_urls":["http://macbook.tail1234.ts.net:5001","http://100.101.102.103:5001"]}
```

`alt_urls` is optional (present only when the server has more than one advertised address, at most 4). It is additive, so the version stays 1 and older apps simply ignore it. The app validates every alternate with the same rules as `server_url` and silently drops invalid ones.

No device credential, legacy token, database path or provider key is ever in the QR. The app (`src/core/qr.ts`) rejects: non-JSON, > 1 KB, wrong product, unknown version, non-http(s) URLs, URLs with path/query/credentials, plain HTTP to public hosts, codes outside the 32-character alphabet, malformed server ids, invalid or expired `expires_at` (2-minute skew tolerance), and old SuperBrain token QRs (explicit message).

## Protocol

1. Owner (loopback client + loopback Host) creates a challenge: 8 characters from Crockford base32 (40 bits), single use, 5-minute TTL (`QIVRA_PAIRING_TTL_S`). Only its SHA-256 is stored.
2. App validates the QR / manual input, calls unauthenticated `GET /api/health`, checks `server_id` matches the QR, and re-checks expiry **against the server's clock** (handles phone clock drift). The user confirms the address (with a plain-HTTP warning).
3. `POST /api/v1/pairing/complete {pairing_id, device_name, server_id}`: wrong server id → 409 (code not consumed); unknown/malformed → 401/400; used → 410 `PAIRING_ALREADY_USED`; expired → 410; invalidated → 410. Consumption is an atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now` (replay- and race-safe).
4. Server returns a device credential `qv1_<32 random bytes>` **once**; stores only its SHA-256.
5. App stores it in SecureStore (Android Keystore-backed), then calls authenticated `GET /api/v1/pairing/status`; only on success is the connection saved and shown as connected. If verification fails the credential is revoked (best effort) and deleted.
6. Revocation: device self-revoke (Disconnect & revoke) or owner (`python -m qivra revoke`, or `POST /api/v1/devices/{id}/revoke` from loopback). Revoked credentials get 401 `INVALID_CREDENTIAL` immediately.

Brute force: 10 attempts/min per client IP (429), and a global budget of 20 failed attempts per 10 minutes — exceeding it invalidates every open challenge. With 2^40 codes this makes guessing infeasible within a code's lifetime.

## Network modes

- **A — same machine/emulator:** default localhost mode. Emulator → `http://10.0.2.2:<port>` (accepted Host). USB phone → `adb reverse tcp:<port> tcp:<port>` → `http://127.0.0.1:<port>`.
- **B — same Wi-Fi:** `--lan`; the QR carries the LAN URL. Allowed Host headers are the detected LAN IPs + loopback names.
- **C — elsewhere (private VPN):** see [Away from home](#away-from-home-tailscale--wireguard). Never port-forward or tunnel the server publicly (SuperBrain's automatic ngrok/localtunnel start was removed).

Changed LAN IP / different Wi-Fi / wrong port → the app's health check fails with a specific message; disconnect and pair again with the new URL. Server restart → credentials and unexpired challenges persist (tested).

## Away from home (Tailscale / WireGuard)

Qivra works outside home Wi-Fi through a **private VPN you control**. The server is never exposed to the internet: it does not start tunnels, never runs `tailscale up/serve/funnel`, and changes no VPN settings — it only *reads* addresses that already exist.

**Tailscale (recommended)**

1. Install Tailscale on the Mac and on the phone, and sign in with the same account on both.
2. Start the server with `--remote` (implies `--lan`):
   ```bash
   .venv/bin/python -m qivra serve --remote
   ```
3. Pair again (scan the new QR). The banner shows:
   ```
   Private network (works anywhere)
     http://macbook.tail1234.ts.net:5001   (reachable from this machine; Tailscale/WireGuard — only your own devices can reach it)
     http://100.101.102.103:5001           (…)
   ```

Detection (`server/qivra/netinfo.py`): 100.64.0.0/10 (CGNAT) interface addresses from `ifconfig`, plus — only if the Tailscale CLI exists (`tailscale` on `PATH`, or inside `/Applications/Tailscale.app`) — `tailscale status --json` for this machine's MagicDNS name (`*.ts.net`) and Tailscale IPs. A missing, logged-out or slow CLI is ignored. These hosts are added to the Host allow-list (DNS-rebinding protection still rejects every other name) and to the advertised URLs.

QR order: with `--lan` the LAN URL is primary and the VPN URLs are `alt_urls`; with `--remote` the MagicDNS URL is primary (it survives Tailscale reassigning the 100.x address) and the LAN URL becomes an alternate. When nothing is detected the banner prints a one-line setup hint.

**WireGuard (or another VPN):** addresses in 100.64.0.0/10 are detected automatically. For other ranges, add `--allow-host <vpn-ip> --advertise-url http://<vpn-ip>:<port>`.

**On the phone:** the app remembers every advertised URL (`Connection.altUrls`). When pairing, the probe tries the primary and then the alternates; afterwards each connection check (app start, return to foreground, "Check connection now") falls back to the alternates on network errors and makes the first that answers — with the same `server_id` — the current address. Auth errors (revoked/unauthorized) never fail over. The Connect screen shows a **Works away from home** badge when a VPN address is saved, and a how-to card otherwise. Cleartext HTTP to `*.ts.net` and 100.64/10 is allowed like any private address; Tailscale already encrypts the traffic end to end.

## API (`/api/v1`)

| Method & path | Auth | Purpose |
|---|---|---|
| GET `/api/health` | none | status, product, version, server_id, server time, capabilities |
| POST `/pairing/challenges` | owner | new code + QR payload |
| POST `/pairing/complete` | none (rate-limited) | exchange code for device credential |
| GET `/pairing/status` | device | verify credential; server + AI status |
| GET `/devices` · POST `/devices/{id}/revoke` | device or owner | list / revoke (devices may only revoke themselves) |
| GET/POST `/items`, GET/PATCH/DELETE `/items/{id}` | device | items with optimistic concurrency (`base_revision`, 409 on conflict) |
| POST `/items/{id}/transcripts/import` · GET `/items/{id}/transcripts` | device | SRT/VTT/TXT import, idempotent per item/language/kind/source |
| POST `/items/{id}/media` | device | multipart upload (≤ 200 MB, whitelisted extensions, random filename) |
| POST `/items/{id}/process` · GET `/jobs/{id}` · POST `/jobs/{id}/cancel` | device | durable jobs: metadata, captions, transcribe, enrich |
| POST `/search` | device | keyword search over items and transcript passages |
| POST `/agent/messages` | device | grounded answer (retrieval-only if no provider) |
| POST/GET `/reports`, GET/DELETE `/reports/{id}` | device | reports in a timezone |
| POST `/sync` | device | push changes with base revisions, pull change feed |

Errors: `{"error": {"code", "message"}}`. JSON bodies > 2 MB → 413. Legacy SuperBrain routes stay mounted; the 8-character token works only from loopback (or with `QIVRA_ALLOW_LEGACY_LAN_TOKEN=1`), and paired-device credentials are accepted there too.

## Sync contract

Entities (`item`, `collection`) carry a server `revision` and a global `seq`. Push: `{cursor, changes:[{kind,id,base_revision,deleted,data}]}`; a change is applied only if `base_revision` equals the server's current revision (null = create). Otherwise the server returns its copy in `conflicts` and changes nothing. Pull: all entities with `seq > cursor`. The app overwrites a local item from the feed only if it has no unsynced edits; otherwise it records a conflict. Identical content on both sides is auto-adopted. Resolution (Settings → Sync conflicts): keep this phone's (rebase and push), keep server's, or keep both (local copy saved as a new item). Deletes are tombstones. Transcripts and media are not synced automatically — only sent when the user requests server processing.
