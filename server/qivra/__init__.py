"""Qivra local-server extensions for the SuperBrain backend.

This package adds the versioned `/api/v1` API used by the Qivra Android app:
secure one-time QR pairing, per-device credentials, host/origin validation,
metadata/notes synchronisation with conflict detection, transcript import,
durable processing jobs, grounded agent answers and reports.

It is mounted on the existing SuperBrain FastAPI app (`api.py`), so the legacy
SuperBrain endpoints keep working for loopback clients.
"""

PRODUCT = "Qivra"
SERVER_VERSION = "2.0.0"
API_VERSION = 1
PAIRING_PAYLOAD_VERSION = 1
