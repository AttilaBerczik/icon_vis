"""Per-module detail shards."""

from __future__ import annotations

import json
import os
from collections import defaultdict


def build(out_dir: str, sym, linker, interproc, exec_info, residency, file_meta: dict) -> dict:
    groups: dict[tuple[str, str], list[str]] = defaultdict(list)
    for pid, proc in sym.procs.items():
        meta = file_meta.get(proc.get("file"), {})
        component = meta.get("component") or "unknown"
        stem = os.path.splitext(os.path.basename(proc.get("file", "")))[0]
        groups[(component, stem)].append(pid)
    written = 0
    total_accesses = 0
    for (component, stem), pids in groups.items():
        procs = {}
        for pid in pids:
            proc = sym.procs[pid]
            accs_all = interproc.accesses.get(pid, [])
            # Detail shards carry source-level, intra-procedural accesses.
            # Inter-procedural effects are summarised in index.json/passes.json
            # and stored in full in the SQLite database; repeating hundreds of
            # thousands of propagated records here would balloon the shards.
            accs = [a for a in accs_all if not a.get("propagated")]
            total_accesses += len(accs)
            procs[pid] = {
                "id": pid, "name": proc.get("name"), "kind": proc.get("kind"),
                "module": proc.get("module"), "line": proc.get("line"),
                "end_line": proc.get("end_line"), "exec_space": exec_info["exec_by_proc"].get(pid),
                "exec": exec_info.get("details", {}).get(pid),
                "params": proc.get("params", []),
                "uses": proc.get("uses", []),
                "aliases": proc.get("aliases", []),
                "accesses": [
                    {
                        "entity": a["entity"], "path": a.get("path"), "root": a.get("root"),
                        "root_kind": a.get("root_kind"), "mode": a.get("mode"),
                        "line": a.get("line"), "via": a.get("via"),
                        "exec_space": a.get("exec_space"),
                        "propagated": bool(a.get("propagated")),
                    }
                    for a in accs
                ],
                "calls": [
                    {"callee": c.callee, "line": c.line, "kind": c.kind,
                     "virtual": c.virtual, "args": c.args}
                    for c in linker.calls.get(pid, [])
                ],
                "directives": exec_info.get("directives", {}).get(pid, []),
                "residency_events": residency.get("per_proc", {}).get(pid, []),
                "propagated_access_count": len(accs_all) - len(accs),
                "propagated_entities": sorted({a["entity"] for a in accs_all
                                                if a.get("propagated")})[:1000],
            }
        dest = os.path.join(out_dir, "detail", component, stem + ".json")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump({"component": component, "file": stem, "procedures": procs}, fh,
                      separators=(",", ":"))
        written += 1
    return {"shards": written, "accesses": total_accesses}
