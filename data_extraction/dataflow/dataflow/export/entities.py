"""Entity-centric view: writer/reader sets and transfer events."""

from __future__ import annotations

import json
from collections import defaultdict


def build(path: str, interproc, exec_info, residency) -> dict:
    data: dict[str, dict] = {}
    for pid, accs in interproc.accesses.items():
        for a in accs:
            e = data.setdefault(a["entity"], {
                "id": a["entity"], "kind": a["entity"].split(":", 1)[0],
                "type": a.get("type"), "writers": set(), "readers": set(),
                "writers_transitive": set(), "readers_transitive": set(),
                "read_count": 0, "write_count": 0, "exec_spaces": set(),
                "events": [],
            })
            propagated = bool(a.get("propagated"))
            if a["mode"] in ("write", "readwrite"):
                e["writers_transitive"].add(pid)
                if not propagated:
                    e["writers"].add(pid)
                    e["write_count"] += 1
            if a["mode"] in ("read", "readwrite"):
                e["readers_transitive"].add(pid)
                if not propagated:
                    e["readers"].add(pid)
                    e["read_count"] += 1
            if a.get("exec_space"):
                e["exec_spaces"].add(a["exec_space"])
    for entity, evs in residency.get("events", {}).items():
        e = data.setdefault(entity, {
            "id": entity, "kind": entity.split(":", 1)[0], "type": None,
            "writers": set(), "readers": set(),
            "writers_transitive": set(), "readers_transitive": set(),
            "read_count": 0, "write_count": 0,
            "exec_spaces": set(), "events": [],
        })
        e["events"] = evs
    out = {}
    for entity, e in data.items():
        e["writers"] = sorted(e["writers"])
        e["readers"] = sorted(e["readers"])
        e["writers_transitive"] = sorted(e["writers_transitive"])
        e["readers_transitive"] = sorted(e["readers_transitive"])
        e["exec_spaces"] = sorted(e["exec_spaces"])
        out[entity] = e
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({
            "entities": out,
            "summary": {
                "entities": len(out),
                "with_writers": sum(1 for e in out.values() if e["writers"]),
                "with_events": sum(1 for e in out.values() if e["events"]),
            },
        }, fh, separators=(",", ":"))
    return {"entities": len(out)}
