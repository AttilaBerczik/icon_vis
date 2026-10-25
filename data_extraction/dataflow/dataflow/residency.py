"""Device-residency state and transfer points.

Events come from OpenACC data clauses, explicit UPDATE directives and Kokkos
``deep_copy`` calls. Findings are deliberately conservative and tagged
``approx`` because a full inter-procedural program-order analysis is not
attempted here.
"""

from __future__ import annotations

from collections import defaultdict

from .paths import PathResolver
from .symtab import SymbolTable

_DATA_EVENTS = {
    "COPYIN": "copyin", "COPYOUT": "copyout", "CREATE": "create",
    "DELETE": "delete", "PRESENT": "present", "DEVICE": "present",
    "ATTACH": "attach", "DETACH": "detach", "NO_CREATE": "present",
}


def _events_from_clauses(d: dict) -> list[tuple[str, str]]:
    events = []
    directive = (d.get("directive") or "").upper()
    for clause in d.get("clauses", []):
        cname = clause.get("clause", "")
        if cname not in _DATA_EVENTS:
            continue
        if directive == "UPDATE":
            ev = "update_device" if cname == "DEVICE" else "update_host" if cname == "HOST" else None
            if ev:
                events.append((ev, cname))
            continue
        if directive == "ENTER" and cname in ("CREATE", "COPYIN", "ATTACH"):
            events.append((_DATA_EVENTS[cname], cname))
        elif directive == "EXIT" and cname in ("DELETE", "COPYOUT", "DETACH"):
            events.append((_DATA_EVENTS[cname], cname))
        elif cname in ("COPYIN", "COPYOUT", "CREATE", "DELETE", "PRESENT", "ATTACH", "DETACH"):
            events.append((_DATA_EVENTS[cname], cname))
    return events


def build(sym: SymbolTable, exec_info: dict, accesses: dict[str, list[dict]]) -> dict:
    events: dict[str, list[dict]] = defaultdict(list)
    per_proc: dict[str, list[dict]] = defaultdict(list)

    for pid, dirs in exec_info.get("directives", {}).items():
        proc = sym.procs.get(pid)
        if not proc:
            continue
        if proc.get("lang") == "cpp":
            continue
        resolver = PathResolver(sym, proc)
        known = set(resolver.decls) | {p["name"] for p in proc.get("params", [])}
        mod = proc.get("module")
        known.update(sym.module_vars.get(mod or "", {}).keys())
        for use in sym.visible_uses(mod):
            only = use.get("only")
            known.update((only or {}).keys() if only is not None else sym.module_vars.get(use.get("module"), {}).keys())
        for d in dirs:
            evs = _events_from_clauses(d)
            if not evs:
                continue
            paths = []
            for clause in d.get("clauses", []):
                if clause.get("clause") in _DATA_EVENTS or clause.get("clause") in ("DEVICE", "HOST"):
                    paths.extend(clause.get("vars", []))
            for path in dict.fromkeys(paths):
                root = path.split("%", 1)[0]
                if root not in known:
                    continue
                rp = resolver.resolve(path, pid)
                for ev, clause in evs:
                    rec = {
                        "entity": rp.entity, "event": ev, "clause": clause,
                        "proc": pid, "line": d.get("line"), "file": d.get("file"),
                        "source": d.get("raw", "")[:200],
                        "exec_space": exec_info["exec_by_proc"].get(pid),
                    }
                    events[rp.entity].append(rec)
                    per_proc[pid].append(rec)

    # Kokkos deep_copy / copy events.
    for pid, accs in accesses.items():
        proc = sym.procs.get(pid, {})
        for a in accs:
            if a.get("via") != "copy" or a.get("propagated"):
                continue
            ev = "deep_copy_to" if a["mode"] == "write" else "deep_copy_from"
            rec = {
                "entity": a["entity"], "event": ev, "clause": "kokkos",
                "proc": pid, "line": a.get("line"), "file": a.get("file"),
                "source": "Kokkos::deep_copy", "exec_space": a.get("exec_space"),
            }
            events[a["entity"]].append(rec)
            per_proc[pid].append(rec)

    # add_var(..., lopenacc=.TRUE.) makes a variable device resident.
    for pid, proc in sym.procs.items():
        for stmt in proc.get("stmts", []):
            if stmt.get("op") != "call":
                continue
            if (stmt.get("callee") or "").lower() not in ("add_var", "add_ref", "add_var_real"):
                continue
            args = stmt.get("args", [])
            has_openacc = any(
                (a.get("keyword") or "").lower() in ("lopenacc", "lacc")
                and "true" in (a.get("expr") or "").lower()
                for a in args
            )
            if not has_openacc:
                continue
            path = next((a.get("path") for a in args if a.get("path")), None)
            if not path:
                continue
            resolver = PathResolver(sym, proc)
            rp = resolver.resolve(path, pid)
            if rp.root_kind == "unknown":
                continue
            rec = {"entity": rp.entity, "event": "attach", "clause": "add_var(lopenacc)",
                   "proc": pid, "line": stmt.get("line"), "file": proc.get("file"),
                   "source": stmt.get("text", "")[:200],
                   "exec_space": exec_info["exec_by_proc"].get(pid)}
            events[rp.entity].append(rec)
            per_proc[pid].append(rec)

    # Conservative findings.
    findings = []
    entity_modes: dict[str, dict] = defaultdict(lambda: {"host_write": [], "device_write": [],
                                                          "host_read": [], "device_read": []})
    for pid, accs in accesses.items():
        for a in accs:
            if a.get("propagated"):
                continue
            kind = "device" if a.get("exec_space") == "device" else "host"
            mode = a["mode"]
            if mode in ("write", "readwrite"):
                entity_modes[a["entity"]][f"{kind}_write"].append(a)
            if mode in ("read", "readwrite"):
                entity_modes[a["entity"]][f"{kind}_read"].append(a)
    for entity, evs in events.items():
        names = {e["event"] for e in evs}
        modes = entity_modes.get(entity)
        if not modes:
            continue
        if "present" in names and modes["host_write"] and not ({"update_device"} & names):
            findings.append({
                "kind": "host_write_then_device_present", "entity": entity,
                "detail": "entity is written on the host and later asserted PRESENT on device "
                          "without an UPDATE DEVICE",
                "procs": sorted({a["proc"] for a in modes["host_write"]})[:10],
                "approx": True,
            })
        if modes["device_write"] and modes["host_read"] and not ({"copyout", "update_host"} & names):
            findings.append({
                "kind": "device_write_then_host_read", "entity": entity,
                "detail": "entity is written on device and read on host without COPYOUT/UPDATE HOST",
                "procs": sorted({a["proc"] for a in modes["device_write"]})[:10],
                "approx": True,
            })
    return {
        "events": dict(events),
        "per_proc": dict(per_proc),
        "findings": findings,
        "summary": {
            "entities_with_events": len(events),
            "events": sum(len(v) for v in events.values()),
            "findings": len(findings),
        },
    }
