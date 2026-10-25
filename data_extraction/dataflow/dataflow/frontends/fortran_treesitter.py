"""Fallback Fortran frontend: tree-sitter-fortran.

Used only when fparser2 fails. It produces a reduced fact set: subprograms,
parameter names, calls, assignments, USE statements and directives. Enough to
keep the call graph complete; deep type information is not available.
"""

from __future__ import annotations

import re

from ..facts import empty_facts, make_decl, normalize_path
from ..linemap import LineMap

try:  # pragma: no cover - import guard
    import tree_sitter_fortran as _tsf
    from tree_sitter import Language, Parser
    _LANG = Language(_tsf.language())
except Exception:  # pragma: no cover
    _LANG = None


def available() -> bool:
    return _LANG is not None


def _text(node) -> str:
    try:
        return node.text.decode("utf-8", "replace")
    except Exception:
        return ""


def _paths(text: str) -> list[str]:
    out = []
    for m in re.finditer(r"[A-Za-z_]\w*(?:\s*%\s*[A-Za-z_]\w*)*", text or ""):
        p = re.sub(r"\s*%\s*", "%", m.group(0)).lower()
        if p not in out:
            out.append(p)
    return out


def _name_of(stmt) -> str:
    f = stmt.child_by_field_name("name") if stmt is not None else None
    return _text(f).lower() if f is not None else ""


def _params_of(stmt) -> list[str]:
    if stmt is None:
        return []
    for child in stmt.children:
        if child.type == "parameters":
            return [_text(c).lower() for c in child.children if c.type == "identifier"]
    return []


def parse(path: str, rel_path: str, text: str, linemap: LineMap, profile: str) -> dict:
    from tree_sitter import Parser

    facts = empty_facts(path, rel_path, "fortran", profile, "treesitter")
    if _LANG is None:
        raise RuntimeError("tree-sitter-fortran is not installed")
    parser = Parser(_LANG)
    tree = parser.parse(text.encode("utf-8"))

    def line(node) -> int:
        return linemap.get(node.start_point[0] + 1)[1]

    def module_uses(node) -> list[dict]:
        uses = []
        for child in node.children:
            if child.type == "use_statement":
                txt = _text(child)
                m = re.match(r"\s*use\s*,\s*intrinsic\s*::\s*(\w+)", txt, re.I)
                if m:
                    continue
                m = re.match(r"\s*use\s+([A-Za-z_]\w*)", txt, re.I)
                if m:
                    only = None
                    om = re.search(r"only\s*:\s*(.*)", txt, re.I | re.S)
                    if om:
                        only = {}
                        for item in om.group(1).split(","):
                            item = item.strip()
                            rm = re.match(r"(\w+)\s*=>\s*(\w+)", item)
                            if rm:
                                only[rm.group(1).lower()] = rm.group(2).lower()
                            else:
                                nm = re.match(r"(\w+)", item)
                                if nm:
                                    only[nm.group(1).lower()] = nm.group(1).lower()
                    uses.append({"module": m.group(1).lower(), "only": only, "line": line(child)})
        return uses

    def walk(node, mod: str, host_chain: list[str], inherited_uses: list[dict]):
        for child in node.children:
            if child.type == "module":
                stmt = next((c for c in child.children if c.type == "module_statement"), None)
                modname = _name_of(stmt)
                uses = module_uses(child)
                facts["modules"].append({
                    "name": modname, "file": path, "line": line(stmt) if stmt else 0,
                    "uses": uses, "interfaces": [], "default_private": False,
                    "public": [], "private": [], "access_statements": [],
                })
                walk(child, modname, [], uses)
            elif child.type in ("subroutine", "function"):
                stmt = next((c for c in child.children if c.type == f"{child.type}_statement"), None)
                name = _name_of(stmt)
                is_func = child.type == "function"
                chain = [*host_chain, name] if host_chain else [name]
                pid = "::".join([mod or rel_path, *chain])
                params = [make_decl(a, "unknown", []) for a in _params_of(stmt)]
                proc = {
                    "id": pid, "name": name, "module": mod or None,
                    "host": "::".join(host_chain) if host_chain else None,
                    "kind": "function" if is_func else "subroutine", "lang": "fortran",
                    "file": path, "profile": profile, "line": line(stmt) if stmt else 0,
                    "end_line": line(child), "params": params, "decls": params,
                    "uses": inherited_uses + module_uses(child), "result": name if is_func else None,
                    "bind_c": None, "attrs": [], "aliases": [], "stmts": [], "exec_markers": [],
                }
                _extract_body(child, proc, line)
                facts["procedures"].append(proc)
                walk(child, mod, chain, proc["uses"])
            else:
                walk(child, mod, host_chain, inherited_uses)

    walk(tree.root_node, "", [], [])
    return facts


def _extract_body(node, proc: dict, line_fn) -> None:
    skip = {"subroutine", "function", "module"}
    seen: set[tuple] = set()

    def rec(n):
        for child in n.children:
            if child.type in skip:
                continue
            if child.type in ("call_expression", "subroutine_call"):
                if child.type == "subroutine_call":
                    f = child.child_by_field_name("subroutine")
                    callee = _text(f).lower() if f is not None else ""
                else:
                    callee = _text(child.children[0]).lower() if child.children else ""
                args = []
                for c in child.children:
                    if c.type == "argument_list":
                        for a in c.children:
                            if a.type in ("(", ")", ","):
                                continue
                            if a.type == "keyword_argument":
                                kw = a.child_by_field_name("name")
                                val = a.child_by_field_name("value")
                                expr = _text(val)
                                args.append({"keyword": _text(kw).lower() if kw else None,
                                             "expr": expr, "paths": _paths(expr),
                                             "path": normalize_path(expr)})
                            else:
                                expr = _text(a)
                                args.append({"keyword": None, "expr": expr,
                                             "paths": _paths(expr), "path": normalize_path(expr)})
                key = (line_fn(child), callee)
                if callee and key not in seen:
                    seen.add(key)
                    proc["stmts"].append({"op": "call", "callee": callee, "args": args,
                                          "line": line_fn(child), "text": _text(child)[:400]})
            elif child.type == "assignment_statement":
                lhs = child.child_by_field_name("left")
                right = child.child_by_field_name("right")
                lpath = normalize_path(_text(lhs))
                if lpath:
                    proc["stmts"].append({"op": "assign", "lhs": lpath,
                                          "rhs": _paths(_text(right)),
                                          "line": line_fn(child), "text": _text(child)[:400]})
            elif child.type == "pointer_association_statement":
                lhs = normalize_path(_text(child.children[0])) if child.children else None
                rhs = normalize_path(_text(child.children[-1])) if child.children else None
                if lhs and rhs:
                    proc["aliases"].append({"left": lhs, "right": rhs, "line": line_fn(child)})
            rec(child)

    rec(node)
