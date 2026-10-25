"""Last-resort regex skeleton for Fortran.

Guarantees that every file contributes module/subprogram nodes and CALL edges
even if both real parsers fail. No statement-level data flow.
"""

from __future__ import annotations

import re

from ..facts import empty_facts, make_decl
from ..linemap import LineMap

_MODULE = re.compile(r"^\s*MODULE\s+(?!PROCEDURE)([A-Za-z_]\w*)\s*$", re.I)
_END_MODULE = re.compile(r"^\s*END\s+MODULE\b", re.I)
_SUB = re.compile(r"^\s*(?:(?:PURE|ELEMENTAL|RECURSIVE|IMPURE|MODULE)\s+)*(SUBROUTINE|FUNCTION)\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?", re.I)
_ENDSUB = re.compile(r"^\s*END\s+(SUBROUTINE|FUNCTION)\b", re.I)
_USE = re.compile(r"^\s*USE\s+([A-Za-z_]\w*)", re.I)
_CALL = re.compile(r"\bCALL\s+([A-Za-z_]\w*(?:\s*%\s*[A-Za-z_]\w*)*)", re.I)
_ASSIGN = re.compile(r"^\s*([A-Za-z_]\w*(?:\s*%\s*[A-Za-z_]\w*)*)\s*(?:\([^=]*\))?\s*=", re.I)


def parse(path: str, rel_path: str, text: str, linemap: LineMap, profile: str) -> dict:
    facts = empty_facts(path, rel_path, "fortran", profile, "regex")
    lines = text.splitlines()
    module = ""
    uses: list[dict] = []
    stack: list[dict] = []
    current: dict | None = None

    def close_current(end_line: int):
        nonlocal current
        if current is not None:
            current["end_line"] = linemap.get(end_line)[1]
            facts["procedures"].append(current)
            current = None

    for i, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("!"):
            continue
        m = _MODULE.match(line)
        if m:
            module = m.group(1).lower()
            uses = []
            facts["modules"].append({
                "name": module, "file": path, "line": linemap.get(i)[1],
                "uses": uses, "interfaces": [], "default_private": False,
                "public": [], "private": [], "access_statements": [],
            })
            continue
        if _END_MODULE.match(line):
            close_current(i)
            module = ""
            continue
        m = _USE.match(line)
        if m:
            u = {"module": m.group(1).lower(), "only": None, "line": linemap.get(i)[1]}
            if current is None:
                uses.append(u)
            if current is not None:
                current["uses"].append(u)
            continue
        m = _SUB.match(line)
        if m:
            close_current(i)
            kind = m.group(1).lower()
            name = m.group(2).lower()
            args = [a.strip().lower() for a in (m.group(3) or "").split(",") if a.strip()]
            host_chain = [p["name"] for p in stack]
            chain = [*host_chain, name]
            pid = "::".join([module or rel_path, *chain])
            current = {
                "id": pid, "name": name, "module": module or None,
                "host": "::".join(host_chain) if host_chain else None, "kind": kind,
                "lang": "fortran", "file": path, "profile": profile,
                "line": linemap.get(i)[1], "end_line": linemap.get(i)[1],
                "params": [make_decl(a, "unknown", []) for a in args],
                "decls": [make_decl(a, "unknown", []) for a in args],
                "uses": list(uses), "result": name if kind == "function" else None,
                "bind_c": None, "attrs": [], "aliases": [], "stmts": [], "exec_markers": [],
            }
            stack.append({"name": name})
            continue
        if _ENDSUB.match(line):
            if stack:
                stack.pop()
            close_current(i)
            continue
        if current is not None:
            for cm in _CALL.finditer(line):
                callee = re.sub(r"\s*%\s*", "%", cm.group(1)).lower()
                current["stmts"].append({
                    "op": "call", "callee": callee, "args": [],
                    "line": linemap.get(i)[1], "text": line[:400],
                })
            am = _ASSIGN.match(line)
            if am and line.count("=") >= 1:
                current["stmts"].append({
                    "op": "assign", "lhs": re.sub(r"\s*%\s*", "%", am.group(1)).lower(),
                    "rhs": [], "line": linemap.get(i)[1], "text": line[:400],
                })
    close_current(len(lines))
    return facts
