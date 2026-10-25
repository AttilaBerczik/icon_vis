"""Primary Fortran frontend: fparser2 (Fortran 2003/2008)."""

from __future__ import annotations

import re

from ..facts import (
    FORTRAN_INTRINSICS,
    attr_of,
    empty_facts,
    make_decl,
    normalize_path,
    scan_paths,
    type_name,
)
from ..linemap import LineMap

_ATTR_LIST_TYPES = ("Attr_Spec_List", "Component_Attr_Spec_List")
_SKIP_EXEC = {
    "Internal_Subprogram_Part", "Module_Subprogram_Part", "Interface_Block",
    "Derived_Type_Def", "Specification_Part",
}


def _line(node) -> int:
    item = getattr(node, "item", None)
    span = getattr(item, "span", None)
    if span:
        return span[0]
    return 0


def _text(node) -> str:
    try:
        return str(node) if node is not None else ""
    except Exception:  # broken fparser node
        return ""


def _extract_paths(text: str) -> list[str]:
    """Extract candidate access paths from an expression.

    Everything path-like is returned; the intra-procedural pass keeps only
    paths whose root is a declared parameter/local/module variable. Keeping
    this permissive avoids dropping legal identifiers that happen to be
    Fortran keywords (``value``, ``size``, ``kind``, ...).
    """
    return [p for p in scan_paths(text) if p not in _LITERAL_WORDS]


_LITERAL_WORDS = {
    "true", "false", "null", "not", "and", "or", "eqv", "neqv",
}


def _parse_entity_decl(decl, kind: str = "entity") -> dict | None:
    """Parse ``Entity_Decl`` / ``Component_Decl`` into name/rank/init."""
    from fparser.two import Fortran2003 as F

    name = None
    init = None
    array_spec = None
    for child in getattr(decl, "children", []) or []:
        if child is None:
            continue
        cname = type(child).__name__
        if cname == "Name" and name is None:
            name = str(child).lower()
        elif cname == "Initialization":
            init = _text(child)
            # component pointer init `=> NULL()` also appears as Initialization
        elif "Shape" in cname or cname in ("Assumed_Size_Spec", "Array_Spec"):
            array_spec = _text(child)
    if not name:
        txt = _text(decl)
        m = re.match(r"\s*([A-Za-z_]\w*)", txt)
        if not m:
            return None
        name = m.group(1).lower()
        pm = re.search(r"(\([^()]*\))\s*(?:=>|=|$)", txt)
        if pm and not init:
            array_spec = pm.group(1)
    rank = 0
    if array_spec:
        depth = commas = 0
        for ch in array_spec:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth <= 1:
                commas += 1
        rank = commas + 1
    return {"name": name, "rank": rank, "array_spec": array_spec, "initialization": init}


def _declaration(node) -> list[dict]:
    """Parse one ``Type_Declaration_Stmt`` into zero or more declarations."""
    from fparser.two import Fortran2003 as F

    children = [c for c in getattr(node, "children", []) or [] if c is not None]
    if not children:
        return []
    spec = ""
    attrs: list[str] = []
    entities = []
    for child in children:
        cname = type(child).__name__
        if cname in ("Intrinsic_Type_Spec", "Declaration_Type_Spec", "Derived_Type_Spec"):
            spec = _text(child)
        elif cname in _ATTR_LIST_TYPES:
            attrs = [x.strip() for x in _text(child).split(",") if x.strip()]
        elif cname == "Attr_Spec":
            attrs.append(_text(child))
        elif cname in ("Entity_Decl_List", "Component_Decl_List"):
            entities = [c for c in getattr(child, "children", []) or [] if c is not None]
        elif cname in ("Entity_Decl", "Component_Decl"):
            entities = [child]
    out = []
    if not spec:
        return out
    for ent in entities:
        info = _parse_entity_decl(ent)
        if not info:
            continue
        d = make_decl(
            info["name"], spec, attrs, rank=info["rank"],
            array_spec=info["array_spec"], initialization=info["initialization"],
            line=_line(ent) or _line(node),
        )
        d["class"] = bool(re.match(r"\s*class\s*\(", spec, re.I))
        out.append(d)
    return out


def _parse_use(node) -> dict:
    from fparser.two import Fortran2003 as F

    children = [c for c in getattr(node, "children", []) or [] if c is not None]
    module = ""
    only: dict[str, str] | None = None
    for child in children:
        if type(child).__name__ == "Name" and not module:
            module = str(child).lower()
        elif type(child).__name__ == "Only_List":
            only = {}
            for item in str(child).split(","):
                item = item.strip()
                if not item:
                    continue
                m = re.match(r"([A-Za-z_]\w*)\s*=>\s*([A-Za-z_]\w*)", item)
                if m:
                    only[m.group(1).lower()] = m.group(2).lower()
                else:
                    n = re.match(r"([A-Za-z_]\w*)", item)
                    if n:
                        only[n.group(1).lower()] = n.group(1).lower()
    return {"module": module, "only": only, "line": _line(node)}


def _parse_attrs_from_stmt(stmt) -> tuple[str, list[str], str | None]:
    """Return (name, dummy args, suffix text) for a subroutine/function stmt."""
    from fparser.two import Fortran2003 as F

    name = ""
    args: list[str] = []
    suffix = ""
    for child in getattr(stmt, "children", []) or []:
        if child is None:
            continue
        cname = type(child).__name__
        if cname == "Name" and not name:
            name = str(child).lower()
        elif cname == "Dummy_Arg_List":
            args = [str(a).lower() for a in (getattr(child, "children", []) or []) if a is not None]
        elif cname == "Suffix":
            suffix = _text(child)
    return name, args, suffix


def _parse_type_bound(part) -> tuple[list[dict], dict[str, list[str]]]:
    bindings: list[dict] = []
    generic: dict[str, list[str]] = {}
    for child in getattr(part, "children", []) or []:
        if child is None:
            continue
        cname = type(child).__name__
        text = _text(child)
        if cname == "Specific_Binding":
            m = re.match(
                r"\s*PROCEDURE\s*(?:\(\s*([A-Za-z_]\w*)\s*\))?\s*(?:,\s*([^:]*?))?\s*::\s*"
                r"([A-Za-z_]\w*)(?:\s*=>\s*([A-Za-z_]\w*))?",
                text, re.I | re.S,
            )
            if m:
                iface, attrs, binding, target = m.groups()
                bindings.append({
                    "name": binding.lower(),
                    "target": (target or binding).lower(),
                    "interface": (iface or "").lower() or None,
                    "attrs": [a.strip().lower() for a in (attrs or "").split(",") if a.strip()],
                    "deferred": "deferred" in (attrs or "").lower(),
                })
        elif cname == "Generic_Binding":
            m = re.match(r"\s*GENERIC\s*::\s*([A-Za-z_]\w*)\s*=>\s*(.+)", text, re.I | re.S)
            if m:
                targets = [t.strip().lower() for t in m.group(2).split(",") if t.strip()]
                generic[m.group(1).lower()] = targets
                bindings.append({"name": m.group(1).lower(), "target": None,
                                 "generic": targets, "attrs": [], "deferred": False})
    return bindings, generic


def _parse_derived_type(node, module: str) -> dict:
    stmt = None
    for child in getattr(node, "children", []) or []:
        if child is not None and type(child).__name__ == "Derived_Type_Stmt":
            stmt = child
            break
    name = ""
    extends = None
    abstract = private = False
    if stmt is not None:
        stext = _text(stmt)
        m = re.search(r"::\s*([A-Za-z_]\w*)", stext)
        if m:
            name = m.group(1).lower()
        em = re.search(r"EXTENDS\s*\(\s*([A-Za-z_]\w*)\s*\)", stext, re.I)
        if em:
            extends = em.group(1).lower()
        abstract = "ABSTRACT" in stext.upper()
        private = "PRIVATE" in stext.upper()
    fields = []
    bindings: list[dict] = []
    generic: dict[str, list[str]] = {}
    for child in getattr(node, "children", []) or []:
        if child is None:
            continue
        cname = type(child).__name__
        if cname == "Component_Part":
            for sub in getattr(child, "children", []) or []:
                if sub is not None and type(sub).__name__ == "Data_Component_Def_Stmt":
                    fields.extend(_declaration(sub))
        elif cname == "Type_Bound_Procedure_Part":
            b, g = _parse_type_bound(child)
            bindings.extend(b)
            generic.update(g)
    return {
        "name": name, "module": module, "line": _line(node), "extends": extends,
        "abstract": abstract, "private": private, "fields": fields,
        "bindings": bindings, "generic_bindings": generic,
    }


def _parse_interface(node) -> dict | None:
    text = _text(node)
    first = text.strip().splitlines()[0] if text.strip() else ""
    m = re.match(r"\s*INTERFACE\s+([A-Za-z_]\w*)", first, re.I)
    if not m:
        if re.match(r"\s*ABSTRACT\s+INTERFACE", first, re.I):
            procs = re.findall(r"^\s*(?:SUBROUTINE|FUNCTION)\s+([A-Za-z_]\w*)", text, re.I | re.M)
            return {"name": "__abstract__", "procedures": [p.lower() for p in procs], "abstract": True, "line": _line(node)}
        return None
    procs = re.findall(r"MODULE\s+PROCEDURE\s+([A-Za-z_]\w*)", text, re.I)
    return {"name": m.group(1).lower(), "procedures": [p.lower() for p in procs], "abstract": False, "line": _line(node)}


def _collect_exec(node, out: list) -> None:
    if node is None:
        return
    cname = type(node).__name__
    if cname in _SKIP_EXEC:
        return
    out.append(node)
    for child in getattr(node, "children", []) or []:
        if child is not None:
            _collect_exec(child, out)


def _parse_procedure(node, module: str, host_chain: list[str], file: str, linemap: LineMap, profile: str) -> tuple[dict, list[dict]]:
    from fparser.two import Fortran2003 as F

    is_func = type(node).__name__ == "Function_Subprogram"
    stmt = None
    end = None
    spec = None
    execpart = None
    for child in getattr(node, "children", []) or []:
        if child is None:
            continue
        cname = type(child).__name__
        if cname in ("Subroutine_Stmt", "Function_Stmt"):
            stmt = child
        elif cname in ("End_Subroutine_Stmt", "End_Function_Stmt"):
            end = child
        elif cname == "Specification_Part":
            spec = child
        elif cname == "Execution_Part":
            execpart = child

    if stmt is None:
        return {}, []
    name, arg_names, suffix = _parse_attrs_from_stmt(stmt)
    kind = "function" if is_func else "subroutine"
    chain = [*host_chain, name] if host_chain else [name]
    pid = "::".join([module or file, *chain])
    line = _line(stmt)
    end_line = _line(end) if end is not None else line

    uses: list[dict] = []
    decls: dict[str, dict] = {}
    aliases: list[dict] = []
    stmts: list[dict] = []
    if spec is not None:
        for child in getattr(spec, "children", []) or []:
            if child is None:
                continue
            cname = type(child).__name__
            if cname == "Use_Stmt":
                uses.append(_parse_use(child))
            elif cname == "Type_Declaration_Stmt":
                for d in _declaration(child):
                    decls[d["name"]] = d
            elif cname == "Common_Stmt":
                pass

    # Parameters in declaration order.
    params = []
    for arg in arg_names:
        d = decls.get(arg)
        if d is None:
            d = make_decl(arg, "implicit", [], line=line)
        params.append(d)

    # Function result
    result_name = None
    rm = re.search(r"RESULT\s*\(\s*([A-Za-z_]\w*)\s*\)", suffix, re.I)
    if rm:
        result_name = rm.group(1).lower()
    elif is_func:
        result_name = name
    bind_c = None
    bm = re.search(r"BIND\s*\(\s*C\s*(?:,\s*NAME\s*=\s*\"?([^\"\)]*)\"?)?\s*\)", suffix, re.I)
    if bm:
        bind_c = (bm.group(1) or name).strip().lower()

    # Execution statements
    if execpart is not None:
        nodes: list = []
        _collect_exec(execpart, nodes)
        seen_calls: set[tuple] = set()
        for sn in nodes:
            cname = type(sn).__name__
            ln = _line(sn)
            if cname in ("Assignment_Stmt", "Pointer_Assignment_Stmt"):
                children = [c for c in (getattr(sn, "children", []) or []) if c is not None]
                if len(children) < 2:
                    continue
                lhs_text = _text(children[0])
                # children are [lhs, '=' or '=>', rhs]; rhs is always last.
                rhs_text = _text(children[-1])
                lhs = normalize_path(lhs_text)
                if cname == "Pointer_Assignment_Stmt":
                    rhs = normalize_path(rhs_text)
                    if lhs and rhs:
                        aliases.append({"left": lhs, "right": rhs, "line": ln})
                        stmts.append({"op": "pointer", "lhs": lhs, "rhs": [rhs],
                                      "line": ln, "text": _text(sn)[:400]})
                    continue
                if not lhs:
                    continue
                stmts.append({
                    "op": "assign", "lhs": lhs, "rhs": _extract_paths(rhs_text),
                    "line": ln, "text": _text(sn)[:400],
                })
            elif cname in ("Call_Stmt", "Function_Reference"):
                children = [c for c in (getattr(sn, "children", []) or []) if c is not None]
                if not children:
                    continue
                designator = _text(children[0])
                args_node = children[1] if len(children) > 1 else None
                args = _parse_actual_args(args_node)
                callee = _call_name(designator)
                if not callee:
                    continue
                key = (ln, callee, tuple((a.get("keyword"), a.get("path")) for a in args))
                if key in seen_calls:
                    continue
                seen_calls.add(key)
                stmts.append({
                    "op": "call", "callee": callee, "args": args, "line": ln,
                    "text": _text(sn)[:400],
                })
            elif cname == "Allocate_Stmt":
                allocs = _parse_allocate(sn)
                stmts.append({"op": "allocate", "targets": allocs["targets"],
                              "rhs": allocs["sources"], "line": ln, "text": _text(sn)[:400]})
            elif cname == "Read_Stmt":
                targets = _parse_read_targets(sn)
                stmts.append({"op": "read", "lhs": None, "rhs": targets,
                              "line": ln, "text": _text(sn)[:400]})
            elif cname == "Associate_Stmt":
                for left, right in _parse_associate(sn):
                    aliases.append({"left": left, "right": right, "line": ln})
            elif cname == "Nullify_Stmt":
                txt = _text(sn)
                paths = _extract_paths(txt)
                if paths:
                    stmts.append({"op": "assign", "lhs": paths[0], "rhs": [],
                                  "line": ln, "text": txt[:400]})
            elif cname in ("If_Stmt", "ElseIf_Stmt", "Where_Stmt", "Do_Stmt",
                           "Select_Case_Stmt", "Select_Type_Stmt"):
                children = [c for c in (getattr(sn, "children", []) or []) if c is not None]
                if children:
                    stmts.append({"op": "expr", "rhs": _extract_paths(_text(children[0])),
                                  "line": ln, "text": _text(children[0])[:400]})
                if cname == "Select_Type_Stmt":
                    txt = _text(sn)
                    m = re.search(r"SELECT\s+TYPE\s*\(\s*([A-Za-z_]\w*)\s*=>\s*(.+?)\)", txt, re.I | re.S)
                    if m:
                        right = normalize_path(m.group(2))
                        if right:
                            aliases.append({"left": m.group(1).lower(), "right": right, "line": ln})
            elif cname == "Write_Stmt":
                stmts.append({"op": "expr", "rhs": _extract_paths(_text(sn)),
                              "line": ln, "text": _text(sn)[:400]})

    proc = {
        "id": pid, "name": name, "module": module, "host": "::".join(host_chain) if host_chain else None,
        "kind": kind, "lang": "fortran", "file": file, "profile": profile,
        "line": line, "end_line": end_line, "params": params, "decls": list(decls.values()),
        "uses": uses, "result": result_name, "bind_c": bind_c,
        "attrs": [a.lower() for a in re.findall(r"\b(RECURSIVE|PURE|ELEMENTAL|IMPURE)\b", _text(stmt), re.I)],
        "aliases": aliases, "stmts": stmts, "exec_markers": [],
    }

    # Contained procedures
    contained: list[dict] = []
    for child in getattr(node, "children", []) or []:
        if child is not None and type(child).__name__ == "Internal_Subprogram_Part":
            for sub in getattr(child, "children", []) or []:
                if sub is None:
                    continue
                if type(sub).__name__ == "Internal_Subprogram":
                    inner = [c for c in (getattr(sub, "children", []) or [])
                             if c is not None and type(c).__name__ in
                             ("Subroutine_Subprogram", "Function_Subprogram")]
                    for proc_node in inner:
                        cp, cc = _parse_procedure(proc_node, module, chain, file, linemap, profile)
                        if cp:
                            contained.append(cp)
                        contained.extend(cc)
    return proc, contained


def _call_name(designator: str) -> str | None:
    designator = (designator or "").strip()
    m = re.match(r"([A-Za-z_]\w*(?:\s*%\s*[A-Za-z_]\w*)*)", designator)
    if not m:
        return None
    return re.sub(r"\s*%\s*", "%", m.group(1)).lower()


def _parse_actual_args(args_node) -> list[dict]:
    if args_node is None:
        return []
    out: list[dict] = []
    children = [c for c in (getattr(args_node, "children", []) or []) if c is not None]
    for child in children:
        cname = type(child).__name__
        if cname == "Actual_Arg_Spec":
            sub = [c for c in (getattr(child, "children", []) or []) if c is not None]
            if len(sub) >= 2 and type(sub[0]).__name__ == "Name":
                keyword = str(sub[0]).lower()
                expr = _text(sub[-1])
                out.append({"keyword": keyword, "expr": expr, "paths": _extract_paths(expr),
                            "path": normalize_path(expr)})
            else:
                expr = _text(child)
                out.append({"keyword": None, "expr": expr, "paths": _extract_paths(expr),
                            "path": normalize_path(expr)})
        else:
            expr = _text(child)
            out.append({"keyword": None, "expr": expr, "paths": _extract_paths(expr),
                        "path": normalize_path(expr)})
    return out


def _parse_allocate(node) -> dict:
    targets: list[str] = []
    sources: list[str] = []
    for child in getattr(node, "children", []) or []:
        if child is None:
            continue
        cname = type(child).__name__
        if cname == "Allocation_List":
            for alloc in getattr(child, "children", []) or []:
                if alloc is None:
                    continue
                p = normalize_path(_text(alloc))
                if p:
                    targets.append(p)
        elif cname == "Alloc_Opt_List":
            for opt in getattr(child, "children", []) or []:
                if opt is None:
                    continue
                txt = _text(opt)
                if re.match(r"\s*SOURCE\s*=", txt, re.I):
                    sources.extend(_extract_paths(txt.split("=", 1)[1]))
    return {"targets": targets, "sources": sources}


def _parse_read_targets(node) -> list[str]:
    from fparser.two import Fortran2003 as F

    out: list[str] = []
    for child in getattr(node, "children", []) or []:
        if child is None:
            continue
        if type(child).__name__ == "Input_Item_List":
            out.extend(_extract_paths(_text(child)))
    if not out:
        txt = _text(node)
        if ")" in txt:
            out.extend(_extract_paths(txt.split(")", 1)[1]))
    return out


def _parse_associate(node) -> list[tuple[str, str]]:
    out = []
    txt = _text(node)
    m = re.search(r"ASSOCIATE\s*\((.*)\)\s*$", txt, re.I | re.S)
    if not m:
        return out
    for item in m.group(1).split(","):
        mm = re.match(r"\s*([A-Za-z_]\w*)\s*=>\s*(.+)", item, re.S)
        if mm:
            right = normalize_path(mm.group(2))
            if right:
                out.append((mm.group(1).lower(), right))
    return out


def parse(path: str, rel_path: str, text: str, linemap: LineMap, profile: str) -> dict:
    """Parse one preprocessed Fortran file and return facts.

    Raises on parser failure; the worker then falls back to tree-sitter.
    """
    from fparser.common.readfortran import FortranStringReader
    from fparser.two.parser import ParserFactory
    from fparser.two.utils import walk
    from fparser.two import Fortran2003 as F

    facts = empty_facts(path, rel_path, "fortran", profile, "fparser")
    parser = ParserFactory().create(std="f2008")
    ast = parser(FortranStringReader(text, ignore_comments=False))
    main_file = path

    def rel_line(node) -> int:
        return linemap.get(_line(node))[1]

    for module_node in walk(ast, F.Module):
        mstmt = next((c for c in (module_node.children or [])
                      if c is not None and type(c).__name__ == "Module_Stmt"), None)
        if mstmt is None:
            continue
        mod_name = ""
        for c in mstmt.children or []:
            if c is not None and type(c).__name__ == "Name":
                mod_name = str(c).lower()
                break
        spec = next((c for c in (module_node.children or [])
                     if c is not None and type(c).__name__ == "Specification_Part"), None)
        uses: list[dict] = []
        types: list[dict] = []
        interfaces: list[dict] = []
        module_vars: list[dict] = []
        access_statements: list[str] = []
        default_private = False
        public_names: list[str] = []
        private_names: list[str] = []
        if spec is not None:
            for child in spec.children or []:
                if child is None:
                    continue
                cname = type(child).__name__
                if cname == "Use_Stmt":
                    uses.append(_parse_use(child))
                elif cname == "Derived_Type_Def":
                    types.append(_parse_derived_type(child, mod_name))
                elif cname == "Interface_Block":
                    iface = _parse_interface(child)
                    if iface and not iface.get("abstract"):
                        interfaces.append(iface)
                elif cname == "Type_Declaration_Stmt":
                    for d in _declaration(child):
                        d["module"] = mod_name
                        module_vars.append(d)
                elif cname == "Access_Stmt":
                    txt = _text(child)
                    access_statements.append(txt)
                    upper = txt.upper()
                    names = re.findall(r"[A-Za-z_]\w*", txt)[1:]
                    if upper.startswith("PRIVATE"):
                        if names:
                            private_names.extend(n.lower() for n in names)
                        else:
                            default_private = True
                    elif upper.startswith("PUBLIC"):
                        public_names.extend(n.lower() for n in names)
        facts["modules"].append({
            "name": mod_name,
            "file": path,
            "line": rel_line(mstmt),
            "uses": uses,
            "interfaces": interfaces,
            "default_private": default_private,
            "public": public_names,
            "private": private_names,
            "access_statements": access_statements,
        })
        facts["types"].extend(types)
        facts["module_vars"].extend(module_vars)

        # Module procedures (including nested contained procedures).
        for part in [c for c in (module_node.children or [])
                     if c is not None and type(c).__name__ == "Module_Subprogram_Part"]:
            for wrapper in part.children or []:
                if wrapper is None:
                    continue
                procs = []
                if type(wrapper).__name__ == "Module_Subprogram":
                    procs = [c for c in (wrapper.children or []) if c is not None and
                             type(c).__name__ in ("Subroutine_Subprogram", "Function_Subprogram")]
                elif type(wrapper).__name__ in ("Subroutine_Subprogram", "Function_Subprogram"):
                    procs = [wrapper]
                for proc_node in procs:
                    proc, contained = _parse_procedure(
                        proc_node, mod_name, [], main_file, linemap, profile
                    )
                    if proc:
                        proc["uses"] = uses + proc["uses"]
                        facts["procedures"].append(proc)
                    facts["procedures"].extend(contained)

    # Programs and standalone procedures.
    for prog_node in walk(ast, F.Main_Program):
        stmt = next((c for c in (prog_node.children or []) if c is not None and
                     type(c).__name__ == "Program_Stmt"), None)
        name = "program"
        if stmt is not None:
            names = [c for c in (stmt.children or []) if c is not None and type(c).__name__ == "Name"]
            if names:
                name = str(names[0]).lower()
        spec = next((c for c in (prog_node.children or []) if c is not None and
                     type(c).__name__ in ("Specification_Part",)), None)
        pid = f"program::{name}"
        pseudo = {
            "id": pid, "name": name, "module": None, "host": None, "kind": "program",
            "lang": "fortran", "file": main_file, "profile": profile,
            "line": rel_line(stmt) if stmt is not None else 0, "end_line": rel_line(prog_node),
            "params": [], "decls": [], "uses": [], "result": None, "bind_c": None,
            "attrs": [], "aliases": [], "stmts": [], "exec_markers": [],
        }
        if spec is not None:
            for child in spec.children or []:
                if child is None:
                    continue
                cname = type(child).__name__
                if cname == "Use_Stmt":
                    pseudo["uses"].append(_parse_use(child))
                elif cname == "Type_Declaration_Stmt":
                    pseudo["decls"].extend(_declaration(child))
        # Reuse statement extraction by faking a subprogram body.
        execpart = next((c for c in (prog_node.children or []) if c is not None and
                         type(c).__name__ == "Execution_Part"), None)
        if execpart is not None:
            nodes: list = []
            _collect_exec(execpart, nodes)
            _extract_stmts_into(nodes, pseudo)
        facts["procedures"].append(pseudo)

    if not facts["modules"] and not facts["procedures"]:
        # Standalone subroutines/functions in an include-style file.
        for proc_node in walk(ast, (F.Subroutine_Subprogram, F.Function_Subprogram)):
            # Skip those already captured in modules/programs (they have parents,
            # but fparser's walk gives all of them, so guard on ids).
            proc, contained = _parse_procedure(proc_node, "", [], main_file, linemap, profile)
            known = {p["id"] for p in facts["procedures"]}
            if proc and proc["id"] not in known:
                facts["procedures"].append(proc)
            for cp in contained:
                if cp["id"] not in known:
                    facts["procedures"].append(cp)

    # Deduplicate procedures by id.
    uniq: dict[str, dict] = {}
    for p in facts["procedures"]:
        uniq.setdefault(p["id"], p)
    facts["procedures"] = list(uniq.values())
    return facts


def _extract_stmts_into(nodes: list, proc: dict) -> None:
    """Statement extraction helper for main programs (same rules as above)."""
    seen_calls: set[tuple] = set()
    for sn in nodes:
        cname = type(sn).__name__
        ln = _line(sn)
        if cname == "Assignment_Stmt":
            children = [c for c in (getattr(sn, "children", []) or []) if c is not None]
            if len(children) < 2:
                continue
            lhs = normalize_path(_text(children[0]))
            if lhs:
                proc["stmts"].append({"op": "assign", "lhs": lhs,
                                      "rhs": _extract_paths(_text(children[-1])),
                                      "line": ln, "text": _text(sn)[:400]})
        elif cname == "Call_Stmt":
            children = [c for c in (getattr(sn, "children", []) or []) if c is not None]
            if not children:
                continue
            callee = _call_name(_text(children[0]))
            args = _parse_actual_args(children[1] if len(children) > 1 else None)
            key = (ln, callee, tuple((a.get("keyword"), a.get("path")) for a in args))
            if callee and key not in seen_calls:
                seen_calls.add(key)
                proc["stmts"].append({"op": "call", "callee": callee, "args": args,
                                      "line": ln, "text": _text(sn)[:400]})
