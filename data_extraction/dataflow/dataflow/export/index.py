"""Build the compact function-level index."""

from __future__ import annotations

import os
from collections import defaultdict

from ..intraproc import aggregate_intents


def _rel(path: str, root: str) -> str:
    try:
        return os.path.relpath(path, root)
    except ValueError:
        return path


def build(sym, linker, interproc, exec_info, file_meta: dict, model_root: str,
          profiles: list[str], timings: dict, manifest_summary: dict) -> dict:
    functions = {}
    edges = []
    for pid, proc in sym.procs.items():
        meta = file_meta.get(proc.get("file"), {})
        all_acc = interproc.accesses.get(pid, [])
        direct = [a for a in all_acc if not a.get("propagated")]
        reads = sorted({a["entity"] for a in direct if a["mode"] in ("read", "readwrite")})
        writes = sorted({a["entity"] for a in direct if a["mode"] in ("write", "readwrite")})
        reads_all = {a["entity"] for a in all_acc if a["mode"] in ("read", "readwrite")}
        writes_all = {a["entity"] for a in all_acc if a["mode"] in ("write", "readwrite")}
        calls = linker.calls.get(pid, [])
        params = aggregate_intents(proc, direct)
        functions[pid] = {
            "id": pid,
            "name": proc.get("name"),
            "module": proc.get("module"),
            "kind": proc.get("kind"),
            "lang": proc.get("lang"),
            "file": _rel(proc.get("file", ""), model_root),
            "rel_path": meta.get("rel_path"),
            "component": meta.get("component"),
            "line": proc.get("line"),
            "end_line": proc.get("end_line"),
            "exec_space": exec_info["exec_by_proc"].get(pid, "unknown"),
            "params": params,
            "result": proc.get("result"),
            "bind_c": proc.get("bind_c"),
            "profiles": proc.get("profiles", []),
            "calls": sorted({c.callee for c in calls}),
            "call_count": len(calls),
            # Counts include inter-procedural effects; the arrays below are the
            # source-level (direct) entities that keep the index compact.
            "read_count": len(reads_all),
            "write_count": len(writes_all),
            "direct_read_count": len(reads),
            "direct_write_count": len(writes),
            "entity_count": len({a["entity"] for a in all_acc}),
            "reads": reads,
            "writes": writes,
            "detail": _detail_path(meta, proc),
        }
    for (caller, callee), weight in linker.weights.items():
        kinds = [c.kind for c in linker.calls.get(caller, []) if c.callee == callee]
        virtual = any(c.virtual for c in linker.calls.get(caller, []) if c.callee == callee)
        edges.append({
            "from": caller, "to": callee, "weight": weight,
            "kind": kinds[0] if kinds else "call", "virtual": virtual,
            "external": callee.startswith("ext:"),
        })
    nodes = set(functions)
    for e in edges:
        nodes.add(e["to"])
    for ext in linker.stubs.values():
        if ext["id"] not in functions:
            functions[ext["id"]] = {
                "id": ext["id"], "name": ext["name"], "module": None, "kind": "external",
                "lang": "external", "file": None, "line": 0, "exec_space": "unknown",
                "params": [], "calls": [], "call_count": 0, "read_count": 0,
                "write_count": 0, "entity_count": 0, "reads": [], "writes": [],
                "detail": None, "external": True, "library": ext.get("library"),
            }
    return {
        "meta": {
            "model_root": os.path.abspath(model_root),
            "profiles": profiles,
            "manifest": manifest_summary,
            "timings": timings,
            "external_nodes": len(linker.stubs),
            "interproc_iterations": interproc.iterations,
            "callbacks": len(linker.callbacks),
            "bindc_links": len(linker.bindc_links),
        },
        "functions": functions,
        "edges": edges,
        "summary": {
            "functions": sum(1 for f in functions.values() if not f.get("external")),
            "external_nodes": len(linker.stubs),
            "edges": len(edges),
            "entities": len({a["entity"] for accs in interproc.accesses.values() for a in accs}),
        },
    }


def _detail_path(meta: dict, proc: dict) -> str | None:
    component = meta.get("component")
    stem = os.path.splitext(os.path.basename(proc.get("file", "")))[0]
    if not component:
        return None
    return f"detail/{component}/{stem}.json"
