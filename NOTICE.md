# Notices

Qivra is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License v3.0** (see [LICENSE](LICENSE)). It comes with **no warranty**.

## Upstream

Qivra began as a fork of **SuperBrain** by **sidinsearch**
(<https://github.com/sidinsearch/superbrain>), licensed under the GNU AGPL v3.0.
The unmodified snapshot is the first commit of this repository; every change since is
in the git history. Copyright in the original code remains with its authors; copyright
in the changes belongs to the Qivra contributors.

Main changes from the upstream project: a new local-first Android app (SQLite library,
on-device search and transcription, share flow, Ask, flashcards, reports, Dev mode), a
new server API with one-time QR pairing and per-device credentials, an AI gateway that
keeps provider keys on the server, server transcription and OCR, sync with conflict
handling, and the security fixes listed in [docs/SECURITY_AND_PRIVACY.md](docs/SECURITY_AND_PRIVACY.md).

## Third-party software

The app uses React Native, Expo SDK modules, React Navigation, SQLite (public domain)
and Ionicons (MIT). The server uses FastAPI, Uvicorn and Pydantic (MIT/BSD), segno (BSD),
fastembed (Apache-2.0) and RapidOCR (Apache-2.0). Each keeps its own license.
