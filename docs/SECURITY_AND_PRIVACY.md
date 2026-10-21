# Security and privacy

## Findings in the SuperBrain baseline (all fixed)

| # | Issue | Fix |
|---|---|---|
| 1 | Unauthenticated `GET /connect-info` returned the permanent API token | Token removed from the response (`server/api.py`) |
| 2 | Pairing QR contained the permanent token | QR now carries a one-time 5-minute code; credentials are issued per device |
| 3 | Token printed to logs at every start | Logged as "loaded (value not logged)" |
| 4 | Server bound `0.0.0.0` by default; ngrok/localtunnel started by default | Loopback by default, `--lan` opt-in, tunnels never auto-started |
| 5 | CORS `*` | No CORS unless `ALLOWED_ORIGINS` is set; unknown `Origin` → 403 |
| 6 | No Host validation (DNS rebinding) | Host allow-list on every route, legacy included (421) |
| 7 | Single static token, no revocation, accepted in query strings, compared non-constant-time | Per-device revocable hashed credentials; legacy token loopback-only and `compare_digest` |
| 8 | Token stored in AsyncStorage on the phone | Device credential in SecureStore (Keystore-backed) |
| 9 | `usesCleartextTraffic=true` with user CAs trusted by default | Network security config trusting system CAs only; HTTP restricted in app code (below) |
| 10 | `start.py` offered to kill whatever held port 5000 (on macOS: ControlCenter) | Removed; next free port is used |

## Controls

- **Pairing:** one-time 40-bit codes, 5-minute TTL, atomic consumption, per-IP and global rate limits, server-id binding, server-clock expiry check, credential verified before it is kept. Codes and credentials are stored only as SHA-256 hashes and never logged (tested).
- **Authorization:** every `/api/v1` route except health and pairing-complete requires a device credential; admin routes require owner (loopback client + loopback Host). A device can revoke only itself. All paired devices belong to the single local owner — there is no multi-user server.
- **Input validation:** Pydantic schemas with length limits, item field allow-list, http(s)-only item URLs, id regex (`^[A-Za-z0-9_-]{1,80}$`), BCP-47 language check, IANA timezone check, 2 MB JSON cap, 200 MB streaming upload cap with extension allow-list and random server-side filenames (path traversal impossible; tested), transcript size cap.
- **SSRF:** server metadata fetch resolves the host and refuses non-global addresses (loopback, RFC1918, link-local, metadata IPs), re-checking each redirect. Residual risk: DNS rebinding between check and connect.
- **Agent / prompt injection:** saved content is untrusted data inside `<source>` blocks with `<`/`>` neutralised; system rules forbid following embedded instructions; instruction-like content is flagged to the user; the model can call only read tools — write tools (reports, tags) become proposals that need explicit confirmation; citations to sources that were not provided are stripped. The server agent endpoint is read-only. Tested with injected content.
- **Commands** extracted from content are displayed and copyable, never executed; destructive patterns are labelled.
- **Android:**
  - Permissions: camera only on "Scan QR", notifications asked once on the first share (Android 13+) or when reminders are enabled, microphone only when recording, no storage/location. The clipboard is read only when the user taps "Paste copied link" (Android shows its own notice). The YouTube player is YouTube's iframe player in a WebView (`react-native-webview`), loaded only after the user presses play or taps a timestamp, and only for YouTube video ids. Files arrive via content URIs and are copied into app-private storage; `ShareActivity` accepts only `content://` URIs and caps sizes.
  - `allowBackup=false`, `fullBackupContent=false`, data-extraction rules exclude everything (cloud backup and device transfer).
  - Exported components: `MainActivity` (launcher + `qivra://` links) and `ShareActivity` (share target) only. Deep links only navigate; they carry no data or commands.
  - "Ready" notifications after a share show the item title and the first sentence of its summary, on a channel whose lock-screen visibility is PRIVATE (content hidden on a secure lock screen); the opt-in daily digest shows up to three item titles on the same kind of PRIVATE channel. `QivraShareTaskService` (headless JS, short `dataSync` foreground service; permissions FOREGROUND_SERVICE and FOREGROUND_SERVICE_DATA_SYNC, no prompt) is not exported and is started only by `ShareActivity`; it accepts only item ids matching `^[A-Za-z0-9_-]{1,80}$` from the task result. Credentials never go to the clipboard, exports or logs.
- **Cleartext HTTP:** Android's network-security-config cannot permit cleartext by IP range, and LAN pairing over plain HTTP is required. So the platform setting permits cleartext, and the app's only HTTP paths (`QivraClient`, the AI provider adapter) refuse `http://` to anything that is not loopback, RFC1918, link-local, CGNAT/Tailscale (100.64/10), IPv6 ULA/link-local or `*.local`. Metadata lookups (YouTube oEmbed, GitHub API) use https. Risk: on an untrusted Wi-Fi, LAN traffic to your server can be observed or altered; the app warns before pairing over HTTP. Mitigation: use HTTPS (`--tls-cert/--tls-key`) or a VPN.
- **External AI:** consent required before content goes to a non-local endpoint configured on the phone; keys in Keystore; https enforced for public hosts.
- **Server AI gateway:** the provider key lives only in the git-ignored `server/qivra.env` (created with mode 0600) or the environment; phones reach it only through device-authenticated `/api/v1/ai/*` routes and receive just the model and host name. Anyone holding a paired-device credential can spend the owner's provider quota — revoke lost phones (`python -m qivra revoke`). Content sent through the gateway goes to the configured provider under its privacy policy.

## Data on the device

`qivra.db` and `files/media/` in app-private storage. Export (JSON, via the Storage Access Framework, verified after writing) and delete-everything are in Settings → Privacy & storage. No analytics, crash reporting or ads.

## Known limitations

- The release APK is signed with the Android **debug key** — anyone with that well-known key could sign an "update". Create a private release keystore before distributing beyond yourself.
- The server's legacy SuperBrain routes (`/analyze`, `/export`, `/settings/*`, `/reset/*`) are still powerful; they now require loopback or a paired device.
- SQLite on the device is not encrypted beyond Android's file-based encryption (SQLCipher was not enabled).
- In-memory rate-limit counters reset when the server restarts (codes still expire within 5 minutes).
