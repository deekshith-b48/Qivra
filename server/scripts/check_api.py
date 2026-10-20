#!/usr/bin/env python3
"""Manually probe an already-running SuperBrain API instance.

This is intentionally a command-line diagnostic rather than a unit test: it
needs the local runtime token and a server listening on the requested address.
"""

import argparse
import json
from pathlib import Path

import requests


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:5000")
    args = parser.parse_args()

    token_path = Path(__file__).resolve().parent.parent / "token.txt"
    if not token_path.is_file():
        raise SystemExit(f"Token file not found: {token_path}")

    response = requests.get(
        f"{args.base_url.rstrip('/')}/recent?limit=10",
        headers={"X-API-Key": token_path.read_text(encoding="utf-8").strip()},
        timeout=10,
    )
    print(f"Status Code: {response.status_code}")
    print(json.dumps(response.json(), indent=2))
    return 0 if response.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
