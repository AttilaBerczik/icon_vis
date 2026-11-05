"""Intra-procedural data flow on normalised field paths."""

from __future__ import annotations

from collections import defaultdict

from .paths import PathResolver
from .symtab import SymbolTable

def _access(proc: dict, rp, mode: str, line: int, via: str) -> dict:
    return {
        "entity": rp.entity,
        "path": rp.path,
        "root": rp.root,
        "root_kind": rp.root_kind,
        "type": rp.type,
        "mode": mode,
        "line": line,
        "via": via,
        "proc": proc["id"],
        "file": proc.get("file"),
        "lang": proc.get("lang"),
        "scope": rp.scope,
    }


def _merge_modes(accesses: list[dict]) -> list[dict]:
    best: dict[tuple, dict] = {}
    for a in accesses:
        key = (a["entity"], a["proc"])
        old = best.get(key)
        if old is None:
            best[key] = dict(a)
            continue
        modes = {old["mode"], a["mode"]}
        if "readwrite" in modes or {"read", "write"} <= modes:
            old["mode"] = "readwrite"
        elif "write" in modes:
            old["mode"] = "write"
        else:
            old["mode"] = "read"
        # Keep all distinct lines for detail output.
        old.setdefault("lines", [old["line"]])
        if a["line"] not in old["lines"]:
            old["lines"].append(a["line"])
    return list(best.values())


def analyse_proc(sym: SymbolTable, proc: dict) -> list[dict]:
    resolver = PathResolver(sym, proc)
    known = set(resolver.decls)
    known.update(proc.get("params") and [p["name"] for p in proc["params"]] or [])
    mod = proc.get("module")
    known.update(sym.module_vars.get(mod or "", {}).keys())
    for use in sym.visible_uses(mod):
        only = use.get("only")
        if only is not None:
            known.update(only.keys())
        else:
            known.update(sym.module_vars.get(use.get("module"), {}).keys())
    if proc.get("lang") == "cpp":
        known.add("this")

    accesses: list[dict] = []

    def add(paths, mode, line, via):
        for p in paths or []:
            root = p.split("%", 1)[0]
            # `known` already contains every declared name. A declared
            # variable may legitimately be called `value`, `size`, `len` or
            # `result`; filtering those as keywords silently dropped their
            # data flow.
            if not p or root not in known:
                continue
            rp = resolver.resolve(p, proc["id"])
            if rp.root_kind == "unknown":
                continue
            accesses.append(_access(proc, rp, mode, line, via))

    for stmt in proc.get("stmts", []):
        op = stmt.get("op")
        line = stmt.get("line", 0)
        if op == "assign":
            add([stmt.get("lhs")], "readwrite" if stmt.get("compound") else "write", line, "assign")
            add(stmt.get("rhs", []), "read", line, "assign")
        elif op == "read":
            add(stmt.get("rhs", []), "write", line, "read")
        elif op == "allocate":
            add(stmt.get("targets", []), "write", line, "allocate")
            add(stmt.get("rhs", []), "read", line, "allocate")
        elif op == "copy":
            add(stmt.get("targets", []), "write", line, "copy")
            add(stmt.get("rhs", []), "read", line, "copy")
        elif op == "expr":
            add(stmt.get("rhs", []), "read", line, "expr")
        elif op == "call":
            # Call effects (both reads and writes) are derived from the
            # callee summary during inter-procedural propagation. Blindly
            # reading every actual here would make an INTENT(OUT) actual look
            # like a read at the call site.
            continue
        elif op == "pointer":
            # Pointer assignment establishes a may-alias (handled by
            # PathResolver); it does not write the pointee. Counting the LHS as
            # a write here would make every `p => target` look like a write to
            # `target`, which heavily over-approximates.
            continue

    # C++ declaration initialisers become reads of the initializer.
    return _merge_modes(accesses)


def intent_mismatches(proc: dict, accesses: list[dict]) -> list[dict]:
    out: list[dict] = []
    by_root: dict[str, set[str]] = defaultdict(set)
    for a in accesses:
        if a.get("root_kind") == "param":
            by_root[a["root"]].add(a["mode"])
    for p in proc.get("params", []):
        intent = (p.get("intent") or "").lower()
        modes = by_root.get(p["name"], set())
        if not modes:
            continue
        wrote = "write" in modes or "readwrite" in modes
        read = "read" in modes or "readwrite" in modes
        if intent == "in" and wrote:
            out.append({"proc": proc["id"], "param": p["name"], "declared": "in",
                        "inferred": "write", "line": proc.get("line")})
        elif intent == "out" and read:
            out.append({"proc": proc["id"], "param": p["name"], "declared": "out",
                        "inferred": "read", "line": proc.get("line")})
    return out


def aggregate_intents(proc: dict, accesses: list[dict]) -> list[dict]:
    by_root: dict[str, set[str]] = defaultdict(set)
    for a in accesses:
        if a.get("root_kind") == "param":
            by_root[a["root"]].add(a["mode"])
    params = []
    for p in proc.get("params", []):
        modes = by_root.get(p["name"], set())
        inferred = "none"
        if "readwrite" in modes or {"read", "write"} <= modes:
            inferred = "inout"
        elif "write" in modes:
            inferred = "out"
        elif "read" in modes:
            inferred = "in"
        params.append({**p, "inferred_intent": inferred})
    return params
