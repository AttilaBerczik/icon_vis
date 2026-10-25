"""Content-addressed fact cache.

A cache entry is a single JSON file keyed by::

    sha256(file content | language | profile | parser/tool version)

Workers write entries atomically; re-runs after small edits only re-parse the
changed files.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile

from . import __version__


def cache_key(path: str, lang: str, profile_sig: str, extra: str = "") -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    h.update(b"\0")
    h.update(lang.encode())
    h.update(b"\0")
    h.update(profile_sig.encode())
    h.update(b"\0")
    h.update(__version__.encode())
    h.update(b"\0")
    h.update(extra.encode())
    return h.hexdigest()


class FactCache:
    def __init__(self, directory: str, enabled: bool = True):
        self.directory = directory
        self.enabled = enabled
        if enabled:
            os.makedirs(directory, exist_ok=True)

    def path(self, key: str) -> str:
        return os.path.join(self.directory, key[:2], key[2:] + ".json")

    def get(self, key: str) -> dict | None:
        if not self.enabled:
            return None
        try:
            with open(self.path(key), encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def put(self, key: str, facts: dict) -> None:
        if not self.enabled:
            return
        dest = self.path(key)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(facts, fh, separators=(",", ":"))
            os.replace(tmp, dest)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
