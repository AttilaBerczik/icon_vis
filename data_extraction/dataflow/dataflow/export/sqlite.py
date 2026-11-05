"""SQLite export for ad-hoc queries."""

from __future__ import annotations

import json
import os
import sqlite3


def build(path: str, sym, linker, interproc, exec_info, residency) -> dict:
    if os.path.exists(path):
        os.unlink(path)
    con = sqlite3.connect(path)
    cur = con.cursor()
    cur.executescript("""
        CREATE TABLE functions (
            id TEXT PRIMARY KEY, name TEXT, module TEXT, kind TEXT, lang TEXT,
            file TEXT, line INTEGER, end_line INTEGER, exec_space TEXT,
            call_count INTEGER, read_count INTEGER, write_count INTEGER
        );
        CREATE TABLE params (
            function_id TEXT, name TEXT, type TEXT, rank INTEGER, intent TEXT,
            inferred_intent TEXT, by_ref INTEGER, const INTEGER,
            optional INTEGER, value INTEGER, line INTEGER
        );
        CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT, type TEXT);
        CREATE TABLE types (
            name TEXT, module TEXT, extends TEXT, fields TEXT,
            file TEXT, line INTEGER
        );
        CREATE TABLE variables (
            id TEXT PRIMARY KEY, kind TEXT, name TEXT, scope TEXT, module TEXT,
            type TEXT, rank INTEGER, line INTEGER, file TEXT, flags INTEGER
        );
        CREATE TABLE accesses (
            function_id TEXT, entity TEXT, mode TEXT, line INTEGER, via TEXT,
            exec_space TEXT, propagated INTEGER
        );
        CREATE TABLE calls (
            caller TEXT, callee TEXT, line INTEGER, kind TEXT, virtual INTEGER,
            external INTEGER
        );
        CREATE TABLE residency_events (
            entity TEXT, event TEXT, proc TEXT, line INTEGER, file TEXT,
            exec_space TEXT, source TEXT
        );
        CREATE TABLE findings (kind TEXT, entity TEXT, detail TEXT);
        CREATE TABLE passes (
            caller TEXT, callee TEXT, line INTEGER, formal TEXT, actual TEXT, mode TEXT
        );
        CREATE TABLE links (kind TEXT, source TEXT, target TEXT, name TEXT, line INTEGER);
        CREATE INDEX idx_access_entity ON accesses(entity);
        CREATE INDEX idx_access_fn ON accesses(function_id);
        CREATE INDEX idx_call_caller ON calls(caller);
        CREATE INDEX idx_call_callee ON calls(callee);
        CREATE INDEX idx_event_entity ON residency_events(entity);
    """)
    from .index import build as _unused  # noqa: F401  (keep relative import path stable)

    for pid, proc in sym.procs.items():
        accs = interproc.accesses.get(pid, [])
        direct = [a for a in accs if not a.get("propagated")]
        cur.execute("INSERT OR REPLACE INTO functions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
            pid, proc.get("name"), proc.get("module"), proc.get("kind"), proc.get("lang"),
            proc.get("file"), proc.get("line"), proc.get("end_line"),
            exec_info["exec_by_proc"].get(pid, "unknown"), len(linker.calls.get(pid, [])),
            len({a["entity"] for a in direct if a["mode"] in ("read", "readwrite")}),
            len({a["entity"] for a in direct if a["mode"] in ("write", "readwrite")}),
        ))
        intent = {}
        for a in direct:
            if a.get("root_kind") == "param":
                intent.setdefault(a["root"], set()).add(a["mode"])
        for p in proc.get("params", []):
            modes = intent.get(p["name"], set())
            inferred = "inout" if {"read", "write"} <= modes else (
                "write" if "write" in modes else "read" if "read" in modes else "none")
            cur.execute("INSERT INTO params VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                pid, p.get("name"), p.get("type"), p.get("rank", 0), p.get("intent"),
                inferred, int(bool(p.get("by_ref"))), int(bool(p.get("const"))),
                int(bool(p.get("optional"))), int(bool(p.get("value"))), p.get("line"),
            ))
    entity_rows = {}
    for accs in interproc.accesses.values():
        for a in accs:
            entity_rows.setdefault(a["entity"], a)
    for entity, a in entity_rows.items():
        cur.execute("INSERT OR REPLACE INTO entities VALUES (?,?,?)", (
            entity, entity.split(":", 1)[0], a.get("type")))
    # Derived-type table. The static viewer exporter uses it to merge equivalent
    # field paths (t_nh_state%prog%rho == t_nh_prog%rho).
    from .vis import _find_component_line, _find_type_declaration_line
    for name, entries in sym.types.items():
        for t in entries:
            file = t.get("file") or t.get("rel_path")
            line = _find_type_declaration_line(file, name)
            if not line:
                line = t.get("line")
            fields = []
            for field in t.get("fields") or []:
                field = dict(field)
                field["line"] = _find_component_line(
                    file, name, field.get("name"), field.get("line"))
                fields.append(field)
            cur.execute("INSERT INTO types VALUES (?,?,?,?,?,?)", (
                t.get("name") or name, t.get("module"), t.get("extends"),
                json.dumps(fields, separators=(",", ":")),
                file, line))

    def _flags(decl: dict) -> int:
        flags = 0
        for flag, key in ((1, "optional"), (2, "pointer"), (4, "allocatable"),
                          (8, "target"), (16, "value"), (32, "save"),
                          (64, "by_ref"), (128, "const")):
            if decl.get(key):
                flags |= flag
        return flags

    # Every declared holder, so the explorer can list struct-typed variables
    # even when they are never accessed.
    module_file = {name: (mod or {}).get("file") for name, mod in sym.modules.items()}
    for module, variables in sym.module_vars.items():
        for name, decl in variables.items():
            cur.execute("INSERT OR REPLACE INTO variables VALUES (?,?,?,?,?,?,?,?,?,?)", (
                f"var:{module}::{name}", "var", name, module, module,
                decl.get("type"), decl.get("rank") or 0, decl.get("line"),
                module_file.get(module) or decl.get("file"), _flags(decl)))
    for pid, proc in sym.procs.items():
        for p in proc.get("params") or []:
            cur.execute("INSERT OR REPLACE INTO variables VALUES (?,?,?,?,?,?,?,?,?,?)", (
                f"param:{pid}::{p.get('name')}", "param", p.get("name"), pid,
                proc.get("module"), p.get("type"), p.get("rank") or 0,
                p.get("line"), proc.get("file"), _flags(p)))
        for decl in proc.get("decls") or []:
            cur.execute("INSERT OR REPLACE INTO variables VALUES (?,?,?,?,?,?,?,?,?,?)", (
                f"local:{pid}::{decl.get('name')}", "local", decl.get("name"), pid,
                proc.get("module"), decl.get("type"), decl.get("rank") or 0,
                decl.get("line"), proc.get("file"), _flags(decl)))
    for pid, accs in interproc.accesses.items():
        for a in accs:
            cur.execute("INSERT INTO accesses VALUES (?,?,?,?,?,?,?)", (
                pid, a["entity"], a["mode"], a.get("line"), a.get("via"),
                a.get("exec_space"), int(bool(a.get("propagated")))))
    for (caller, callee), _w in linker.weights.items():
        sites = [c for c in linker.calls.get(caller, []) if c.callee == callee]
        if sites:
            cur.execute("INSERT INTO calls VALUES (?,?,?,?,?,?)", (
                caller, callee, sites[0].line, sites[0].kind,
                int(any(c.virtual for c in sites)), int(callee.startswith("ext:"))))
    for entity, evs in residency.get("events", {}).items():
        for e in evs:
            cur.execute("INSERT INTO residency_events VALUES (?,?,?,?,?,?,?)", (
                entity, e.get("event"), e.get("proc"), e.get("line"),
                e.get("file"), e.get("exec_space"), e.get("source")))
    for f in residency.get("findings", []):
        cur.execute("INSERT INTO findings VALUES (?,?,?)", (f["kind"], f["entity"], f["detail"]))
    for p in interproc.passes:
        cur.execute("INSERT INTO passes VALUES (?,?,?,?,?,?)", (
            p["caller"], p["callee"], p["line"], p["formal"], p["actual"], p["mode"]))
    for b in linker.bindc_links:
        cur.execute("INSERT INTO links VALUES (?,?,?,?,?)", (
            b.get("kind", "bindc"), b.get("fortran"), b.get("cpp"), b.get("name"), None))
    for c in linker.callbacks:
        cur.execute("INSERT INTO links VALUES (?,?,?,?,?)", (
            "callback", c.get("caller"), c.get("target"), c.get("via"), c.get("line")))
    cur.execute("CREATE INDEX idx_pass_actual ON passes(actual)")
    cur.execute("CREATE INDEX idx_pass_formal ON passes(formal)")
    con.commit()
    con.close()
    return {"db": path}
