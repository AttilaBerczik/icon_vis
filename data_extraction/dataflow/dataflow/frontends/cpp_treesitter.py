"""C++ frontend: tree-sitter-cpp on masked, conditionally-preprocessed sources."""

from __future__ import annotations

import re

from ..facts import empty_facts, make_decl, normalize_path
from ..linemap import LineMap
from .masking import mask_source

try:  # pragma: no cover
    import tree_sitter_cpp as _tscpp
    from tree_sitter import Language, Parser
    _LANG = Language(_tscpp.language())
except Exception:  # pragma: no cover
    _LANG = None

_ID_TYPES = {
    "identifier", "field_identifier", "type_identifier", "namespace_identifier",
    "operator_name", "destructor_name", "template_type",
}
_SKIP_SCOPES = {"function_definition"}

_TYPE_WORDS = {
    "std", "auto", "const", "void", "int", "double", "float", "bool", "char",
    "long", "short", "unsigned", "signed", "size_t", "true", "false", "nullptr",
    "this", "return", "if", "else", "for", "while", "switch", "case", "break",
    "continue", "static_cast", "constexpr", "inline", "template", "typename",
}


def _text(node) -> str:
    try:
        return node.text.decode("utf-8", "replace")
    except Exception:
        return ""


def _line(node) -> int:
    return node.start_point[0] + 1


def _matching(text: str, i: int) -> int:
    pair = {"(": ")", "[": "]", "<": ">"}
    open_ch = text[i]
    close_ch = pair[open_ch]
    depth = 0
    while i < len(text):
        if text[i] == open_ch:
            depth += 1
        elif text[i] == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return len(text)


def _read_component(text: str, i: int) -> tuple[str, int]:
    n = len(text)
    while i < n and text[i].isspace():
        i += 1
    if i >= n or not (text[i].isalpha() or text[i] == "_"):
        return "", i
    start = i
    i += 1
    while i < n and (text[i].isalnum() or text[i] == "_"):
        i += 1
    return text[start:i].lower(), i


def _read_path(text: str, i: int) -> tuple[str, int, list[str]]:
    comps: list[str] = []
    inner: list[str] = []
    n = len(text)
    while True:
        comp, i = _read_component(text, i)
        if not comp:
            break
        comps.append(comp)
        while i < n and text[i] in "([<":
            end = _matching(text, i)
            inner.extend(_scan_paths(text[i + 1:end - 1]))
            i = end
        k = i
        while k < n and text[k].isspace():
            k += 1
        if text.startswith("->", k):
            i = k + 2
            continue
        if k < n and text[k] in ".:":
            # `::` is namespace qualification; `.` is a member access.
            i = k + (2 if text.startswith("::", k) else 1)
            continue
        break
    return "%".join(comps), i, inner


def _scan_paths(text: str) -> list[str]:
    out: list[str] = []
    i, n = 0, len(text or "")
    while i < n:
        if text[i].isalpha() or text[i] == "_":
            path, end, inner = _read_path(text, i)
            if path and path not in out:
                out.append(path)
            for p in inner:
                if p not in out:
                    out.append(p)
            i = max(end, i + 1)
        else:
            i += 1
    return out


def _cpp_path(text: str) -> str | None:
    if not text:
        return None
    paths = [p for p in _scan_paths(text.strip()) if p not in _TYPE_WORDS]
    return paths[0] if paths else None


def _paths(text: str) -> list[str]:
    return [p for p in _scan_paths(text or "") if p not in _TYPE_WORDS]


def _declarator_name(node) -> str:
    if node is None:
        return ""
    t = node.type
    if t in _ID_TYPES:
        return _text(node).lower()
    if t in ("pointer_declarator", "reference_declarator", "array_declarator",
             "parenthesized_declarator", "attributed_declarator", "structured_binding_declarator"):
        for child in node.children:
            if child.type not in ("*", "&", "&&", "[", "]", "(", ")"):
                name = _declarator_name(child)
                if name:
                    return name
    if t == "function_declarator":
        return _declarator_name(node.child_by_field_name("declarator"))
    if t == "init_declarator":
        return _declarator_name(node.child_by_field_name("declarator"))
    if t == "qualified_identifier":
        name = node.child_by_field_name("name")
        return _declarator_name(name)
    if t == "template_function":
        return _declarator_name(node.child_by_field_name("name"))
    if t == "operator_cast":
        return "operator_cast"
    return ""


def _unwrap_declarator(node):
    seen = set()
    while node is not None and id(node) not in seen and node.type in (
        "pointer_declarator", "reference_declarator", "parenthesized_declarator",
        "attributed_declarator", "init_declarator",
    ):
        seen.add(id(node))
        nxt = node.child_by_field_name("declarator")
        if nxt is None:
            for c in node.children:
                if c.type.endswith("declarator"):
                    nxt = c
                    break
        node = nxt
    return node


def _cpp_type_name(spec: str) -> str:
    """Normalise a C++ type for field-path rooting.

    ``const State&`` / ``State*`` / ``struct State`` all become ``state`` so a
    method call or field access resolves through the same type table entry.
    Template instantiations and namespaces are reduced to the base name.
    """
    s = (spec or "auto").strip()
    s = re.sub(r"\b(const|volatile|constexpr|static|inline|typename|struct|class|mutable)\b", " ", s)
    s = s.split("<", 1)[0]
    s = re.sub(r"[\*&]+", "", s)
    s = s.strip().split("::")[-1]
    return (s or "auto").lower()


def _array_rank(decl) -> int:
    node = decl
    while node is not None:
        if node.type == "array_declarator":
            dims = node.child_by_field_name("size")
            count = 1
            # Count sibling array_declarator wrappers for multi-dimensional arrays.
            inner = node.child_by_field_name("declarator")
            while inner is not None and inner.type == "array_declarator":
                count += 1
                inner = inner.child_by_field_name("declarator")
            return count
        node = node.child_by_field_name("declarator")
    return 0


def _function_declarator(node):
    node = _unwrap_declarator(node)
    if node is not None and node.type == "function_declarator":
        return node
    if node is not None:
        for c in node.children:
            if c.type == "function_declarator":
                return c
    return None


def _parse_params(func_decl) -> list[dict]:
    params: list[dict] = []
    plist = func_decl.child_by_field_name("parameters") if func_decl is not None else None
    if plist is None:
        return params
    for child in plist.children:
        if child.type != "parameter_declaration":
            continue
        type_node = child.child_by_field_name("type")
        decl_node = child.child_by_field_name("declarator")
        qualifiers = [_text(c) for c in child.children if c.type == "type_qualifier"]
        spec = _text(type_node) if type_node is not None else "auto"
        name = _declarator_name(decl_node) or "param"
        rank = _array_rank(decl_node) if decl_node is not None else 0
        is_ref = decl_node is not None and decl_node.type == "reference_declarator"
        is_ptr = decl_node is not None and decl_node.type == "pointer_declarator"
        d = make_decl(name, spec, [], rank=rank)
        d["type"] = _cpp_type_name(spec)
        d["by_ref"] = bool(is_ref)
        d["pointer"] = bool(is_ptr)
        d["const"] = any("const" in q for q in qualifiers) or spec.startswith("const")
        d["value"] = not (is_ref or is_ptr)
        params.append(d)
    return params


def _class_fields(node, class_name: str) -> dict:
    fields: list[dict] = []
    methods: list[dict] = []
    base = None
    bc = next((c for c in node.children if c.type == "base_class_clause"), None)
    if bc is not None:
        names = [c for c in bc.children if c.type in ("qualified_identifier", "type_identifier")]
        if names:
            base = _text(names[0]).split("::")[-1].lower()
    body = node.child_by_field_name("body")
    for child in (body.children if body is not None else []):
        if child.type == "field_declaration":
            decl = child.child_by_field_name("declarator")
            fd = _function_declarator(decl)
            if fd is not None:
                methods.append({"name": _declarator_name(fd.child_by_field_name("declarator"))})
                continue
            type_node = child.child_by_field_name("type")
            spec = _text(type_node) if type_node is not None else "auto"
            name = _declarator_name(decl)
            if not name:
                continue
            d = make_decl(name, spec, [], rank=_array_rank(decl) if decl is not None else 0)
            d["type"] = _cpp_type_name(spec)
            d["class"] = class_name
            fields.append(d)
        elif child.type == "function_definition":
            fd = _function_declarator(child.child_by_field_name("declarator"))
            if fd is not None:
                methods.append({"name": _declarator_name(fd.child_by_field_name("declarator"))})
    return {"fields": fields, "methods": methods, "base": base}


def _resolve_callee(fn_node) -> tuple[str, str | None, str | None]:
    """Return (callee, receiver path, scope qualifier) for a call node."""
    if fn_node is None:
        return "", None, None
    t = fn_node.type
    if t in ("identifier", "field_identifier", "qualified_identifier", "template_function",
             "operator_name", "destructor_name"):
        txt = _text(fn_node)
        # qualified: Kokkos::deep_copy
        if "::" in txt:
            parts = [p.strip() for p in txt.split("::")]
            return parts[-1].lower(), None, "::".join(parts[:-1]).lower() or None
        return txt.lower(), None, None
    if t == "field_expression":
        field = fn_node.child_by_field_name("field")
        argument = fn_node.child_by_field_name("argument")
        recv = _cpp_path(_text(argument)) if argument is not None else None
        return _text(field).lower(), recv, None
    if t == "template_method":
        name = fn_node.child_by_field_name("name")
        return _text(name).lower(), None, None
    return _text(fn_node).lower(), None, None


def _args(node) -> list[dict]:
    args: list[dict] = []
    if node is None:
        return args
    for c in node.children:
        if c.type in ("(", ")", ","):
            continue
        expr = _text(c)
        args.append({"keyword": None, "expr": expr, "paths": _paths(expr),
                     "path": _cpp_path(expr)})
    return args


def parse(path: str, rel_path: str, raw_text: str, linemap: LineMap,
          profile: str, exec_markers: list[dict] | None = None) -> dict:
    from tree_sitter import Parser

    if _LANG is None:
        raise RuntimeError("tree-sitter-cpp is not installed")
    facts = empty_facts(path, rel_path, "cpp", profile, "cpp")
    masked, markers = mask_source(raw_text)
    # Markers' line numbers refer to preprocessed text; facts store original lines.
    for m in markers:
        m["orig_line"] = linemap.get(m["line"])[1]
        m["file"] = linemap.get(m["line"])[0]
    facts["exec_markers"] = markers
    if exec_markers:
        facts["exec_markers"].extend(exec_markers)

    parser = Parser(_LANG)
    tree = parser.parse(masked.encode("utf-8"))

    def orig_line(node) -> int:
        return linemap.get(_line(node))[1]

    def add_function(fn_node, scope: list[str], class_scope: str | None):
        fd = _function_declarator(fn_node.child_by_field_name("declarator"))
        if fd is None:
            return
        name = _declarator_name(fd.child_by_field_name("declarator"))
        if not name:
            return
        qualified = "::".join([*scope, *([class_scope] if class_scope else []), name])
        pid = f"cpp:{qualified}@{orig_line(fn_node)}"
        params = _parse_params(fd)
        decls = list(params)
        stmts: list[dict] = []
        aliases: list[dict] = []
        local_markers: list[dict] = []

        def rec(n, in_lambda=False):
            for child in n.children:
                if child.type in ("lambda_expression",):
                    local_markers.append({"macro": "lambda", "space": "device",
                                          "orig_line": orig_line(child)})
                    rec(child, True)
                    continue
                if child.type == "function_definition" and child is not fn_node:
                    continue
                if child.type == "declaration":
                    for init in _collect_decls(child, decls, orig_line):
                        stmts.append(init)
                elif child.type == "assignment_expression":
                    left = child.child_by_field_name("left")
                    right = child.child_by_field_name("right")
                    op = child.child_by_field_name("operator")
                    lpath = _cpp_path(_text(left))
                    if lpath:
                        opl = _text(op) if op is not None else "="
                        stmts.append({
                            "op": "assign", "lhs": lpath, "rhs": _paths(_text(right)),
                            "line": orig_line(child), "text": _text(child)[:400],
                            "compound": opl not in ("=", ""),
                        })
                elif child.type == "update_expression":
                    txt = _text(child)
                    p = _cpp_path(txt)
                    if p:
                        stmts.append({"op": "assign", "lhs": p, "rhs": [p],
                                      "line": orig_line(child), "text": txt[:400]})
                elif child.type == "call_expression":
                    fn = child.child_by_field_name("function")
                    callee, recv, qual = _resolve_callee(fn)
                    args = _args(child.child_by_field_name("arguments"))
                    if callee:
                        if callee in ("deep_copy", "create_mirror_view_and_copy", "copy"):
                            if args:
                                stmts.append({"op": "copy", "targets": [a["path"] for a in args[:1] if a["path"]],
                                              "rhs": [p for a in args[1:] for p in a["paths"]],
                                              "line": orig_line(child), "text": _text(child)[:400]})
                        elif callee == "View":
                            if args and args[0]["path"]:
                                aliases.append({"left": name, "right": args[0]["path"],
                                                "line": orig_line(child)})
                        else:
                            # Arguments are read by the caller. deep_copy's
                            # destination is excluded because it is a write.
                            read_paths = [p for a in args for p in a["paths"]]
                            if read_paths:
                                stmts.append({"op": "expr", "rhs": read_paths,
                                              "line": orig_line(child), "text": _text(child)[:400]})
                        stmts.append({
                            "op": "call", "callee": callee, "receiver": recv,
                            "scope": qual, "args": args, "line": orig_line(child),
                            "text": _text(child)[:400],
                            "in_lambda": in_lambda,
                        })
                elif child.type in ("return_statement", "if_statement", "while_statement",
                                    "for_statement", "switch_statement"):
                    expr_node = child.child_by_field_name("condition")
                    if expr_node is None and child.type == "return_statement":
                        expr_node = next((c for c in child.children if c.type not in ("return", ";")), None)
                    if expr_node is not None:
                        paths = _paths(_text(expr_node))
                        if paths:
                            stmts.append({"op": "expr", "rhs": paths,
                                          "line": orig_line(child), "text": _text(child)[:400]})
                elif child.type == "pointer_association_statement":
                    pass
                rec(child, in_lambda)

        rec(fn_node)
        proc = {
            "id": pid, "name": name, "module": scope[-1] if scope else None,
            "host": "::".join(scope) or None, "kind": "function", "lang": "cpp",
            "file": path, "profile": profile, "line": orig_line(fn_node),
            "end_line": linemap.get(fn_node.end_point[0] + 1)[1],
            "params": params, "decls": decls, "uses": [], "result": _text(fn_node.child_by_field_name("type")),
            "bind_c": None, "attrs": [], "aliases": aliases, "stmts": stmts,
            "exec_markers": local_markers + [
                {"macro": "KOKKOS_LAMBDA", "space": "device", "orig_line": m["orig_line"]}
                for m in markers if m.get("space") == "device"
                and orig_line(fn_node) <= m.get("orig_line", 0) <= linemap.get(fn_node.end_point[0] + 1)[1]
            ],
            "qualified": qualified,
        }
        facts["procedures"].append(proc)

    def walk(node, scope: list[str], class_scope: str | None):
        for child in node.children:
            if child.type == "namespace_definition":
                name_node = child.child_by_field_name("name")
                ns = _text(name_node).lower() if name_node is not None else ""
                body = child.child_by_field_name("body")
                walk(body if body is not None else child, scope + ([ns] if ns else []), class_scope)
            elif child.type in ("class_specifier", "struct_specifier", "union_specifier"):
                name_node = child.child_by_field_name("name")
                cname = _text(name_node).lower() if name_node is not None else ""
                info = _class_fields(child, cname)
                if cname:
                    facts["types"].append({
                        "name": cname, "module": scope[-1] if scope else None,
                        "line": orig_line(child), "extends": info["base"],
                        "abstract": False, "private": child.type == "class_specifier",
                        "fields": info["fields"], "bindings": info["methods"],
                        "generic_bindings": {}, "scope": "::".join(scope), "lang": "cpp",
                    })
                walk(child, scope, cname or class_scope)
            elif child.type == "function_definition":
                add_function(child, scope, class_scope)
                # Do not descend into nested function bodies here.
            elif child.type == "template_declaration":
                walk(child, scope, class_scope)
            elif child.type == "linkage_specification":
                body = child.child_by_field_name("body")
                walk(body if body is not None else child, scope, class_scope)

    walk(tree.root_node, [], None)
    return facts


def _collect_decls(node, decls: list[dict], line_fn=None) -> list[dict]:
    """Collect declarations and return initialiser assignments as statements."""
    type_node = node.child_by_field_name("type")
    spec = _text(type_node) if type_node is not None else "auto"
    qualifiers = [_text(c) for c in node.children if c.type == "type_qualifier"]
    inits: list[dict] = []
    line = line_fn(node) if line_fn else 0
    for child in node.children:
        if child.type not in ("init_declarator", "identifier", "field_identifier",
                              "pointer_declarator", "reference_declarator", "array_declarator"):
            continue
        if child.type in ("identifier", "field_identifier"):
            d = make_decl(_text(child).lower(), spec, [])
            d["type"] = _cpp_type_name(spec)
            decls.append(d)
        elif child.type in ("pointer_declarator", "reference_declarator", "array_declarator", "init_declarator"):
            name = _declarator_name(child)
            if not name:
                continue
            rank = _array_rank(child)
            d = make_decl(name, spec, [], rank=rank)
            d["type"] = _cpp_type_name(spec)
            d["const"] = any("const" in q for q in qualifiers) or spec.startswith("const")
            d["by_ref"] = child.type == "reference_declarator"
            d["pointer"] = child.type == "pointer_declarator"
            decls.append(d)
            if child.type == "init_declarator":
                value = child.child_by_field_name("value")
                if value is not None:
                    inits.append({
                        "op": "assign", "lhs": name,
                        "rhs": _paths(_text(value)), "line": line_fn(value) if line_fn else line,
                        "text": _text(child)[:400],
                    })
    return inits
