"""Fact schema helpers shared by the frontends.

Facts are plain dictionaries so workers can cache them as JSON and the global
analysis can run in the main process without any AST objects.
"""

from __future__ import annotations

import re

SCHEMA_VERSION = 1

_KEYWORDS = {
    "if", "then", "else", "elseif", "endif", "end", "do", "enddo", "while",
    "select", "case", "where", "forall", "call", "subroutine", "function",
    "result", "intent", "in", "out", "inout", "real", "integer", "logical",
    "character", "complex", "type", "class", "dimension", "allocatable",
    "pointer", "target", "optional", "value", "save", "parameter", "public",
    "private", "use", "only", "implicit", "none", "module", "contains",
    "return", "stop", "print", "write", "read", "allocate", "deallocate",
    "nullify", "associated", "present", "size", "kind", "len", "trim",
    "max", "min", "abs", "sum", "any", "all", "count", "reshape", "matmul",
    "transpose", "sqrt", "exp", "log", "sin", "cos", "tan", "atan", "mod",
    "floor", "ceiling", "nint", "int", "real", "cmplx", "merge", "spread",
    "pack", "unpack", "c_loc", "c_funloc", "c_associated", "c_sizeof",
}

# Fortran intrinsic procedures; never treated as model call edges.
FORTRAN_INTRINSICS = {
    "abs", "aimag", "aint", "anint", "ceiling", "cmplx", "conjg", "dim",
    "dprod", "floor", "int", "max", "min", "mod", "modulo", "nint", "real",
    "sign", "sqrt", "exp", "log", "log10", "sin", "cos", "tan", "asin",
    "acos", "atan", "atan2", "sinh", "cosh", "tanh", "erf", "erfc",
    "gamma", "log_gamma", "hypot", "bessel_j0", "bessel_j1", "bessel_jn",
    "bessel_y0", "bessel_y1", "bessel_yn", "bit_size", "btest", "iand",
    "ior", "ieor", "not", "ishft", "ishftc", "ibset", "ibclr", "ibits",
    "mvbits", "achar", "char", "iachar", "ichar", "index", "len_trim",
    "len", "lge", "lgt", "lle", "llt", "repeat", "scan", "trim", "verify",
    "adjustl", "adjustr", "merge", "pack", "spread", "unpack", "reshape",
    "transpose", "matmul", "dot_product", "sum", "product", "maxval",
    "minval", "count", "any", "all", "maxloc", "minloc", "shape", "size",
    "allocated", "associated", "present", "lbound", "ubound", "kind",
    "selected_int_kind", "selected_real_kind", "huge", "tiny", "epsilon",
    "nearest", "spacing", "rrspacing", "scale", "exponent", "fraction",
    "set_exponent", "radix", "digits", "precision", "range", "transfer",
    "null", "c_loc", "c_funloc", "c_f_pointer", "c_associated", "c_sizeof",
    "command_argument_count", "get_command", "get_command_argument",
    "get_environment_variable", "is_iostat_end", "is_iostat_eor",
    "new_line", "same_type_as", "extends_type_of", "storage_size",
    "execute_command_line", "random_number", "random_seed", "date_and_time",
    "system_clock", "cpu_time", "move_alloc", "is_contiguous", "norm2",
    "findloc", "bge", "bgt", "ble", "blt", "dshiftl", "dshiftr", "leadz",
    "trailz", "popcnt", "poppar", "masks", "atomics", "atomic_define",
    "atomic_ref", "atomic_cas", "atomic_add", "atomic_and", "atomic_or",
    "atomic_xor", "atomic_fetch_add", "atomic_fetch_and", "atomic_fetch_or",
    "atomic_fetch_xor",
}

_ATTR_RE = re.compile(r"^\s*(INTENT\s*\(\s*(INOUT|IN|OUT)\s*\)|ALLOCATABLE|POINTER|TARGET|OPTIONAL|VALUE|DIMENSION\s*\((.*?)\)|SAVE|PARAMETER|CONTIGUOUS|PROTECTED|ASYNCHRONOUS|VOLATILE|PUBLIC|PRIVATE)\s*$", re.I)


def type_name(spec: str) -> str:
    """Normalise a declaration type specifier to a stable name."""
    s = (spec or "").strip()
    m = re.match(r"(?i)^(?:type|class)\s*\(\s*([A-Za-z_]\w*)\s*\)$", s)
    if m:
        return m.group(1).lower()
    m = re.match(r"(?i)^(real|integer|logical|complex|character)\s*(?:\(\s*([^)]*)\s*\))?$", s)
    if m:
        return s.lower().replace(" ", "")
    return s.lower().replace(" ", "")


def parse_fortran_attrs(attr_text: str) -> list[str]:
    attrs = []
    for part in re.split(r",(?![^(]*\))", attr_text or ""):
        part = part.strip()
        if part:
            attrs.append(re.sub(r"\s+", "", part.upper()))
    return attrs


def attr_of(attrs: list[str], name: str) -> str | bool | None:
    for a in attrs:
        if a == name:
            return True
        if a.startswith(name + "("):
            return a[len(name) + 1:-1]
    return None


def make_decl(
    name: str,
    spec: str,
    attrs: list[str] | None = None,
    rank: int = 0,
    array_spec: str | None = None,
    initialization: str | None = None,
    line: int | None = None,
) -> dict:
    attrs = attrs or []
    dim = attr_of(attrs, "DIMENSION")
    if array_spec and not rank:
        rank = _rank(array_spec)
    elif isinstance(dim, str) and not rank:
        rank = _rank(dim)
    return {
        "name": name.lower(),
        "type": type_name(spec),
        "rank": rank,
        "array_spec": array_spec or (dim if isinstance(dim, str) else None),
        "attrs": attrs,
        "intent": (attr_of(attrs, "INTENT") or None),
        "optional": bool(attr_of(attrs, "OPTIONAL")),
        "value": bool(attr_of(attrs, "VALUE")),
        "pointer": bool(attr_of(attrs, "POINTER")),
        "allocatable": bool(attr_of(attrs, "ALLOCATABLE")),
        "target": bool(attr_of(attrs, "TARGET")),
        "parameter": bool(attr_of(attrs, "PARAMETER")),
        "save": bool(attr_of(attrs, "SAVE")),
        "initialization": initialization,
        "line": line,
    }


def _rank(spec: str) -> int:
    depth = 0
    commas = 0
    for ch in spec:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 1:
            commas += 1
    return commas + 1 if spec.strip().startswith("(") else 0


def path_root(path: str) -> str:
    return path.split("%", 1)[0].lower()


def path_fields(path: str) -> list[str]:
    return [p.lower() for p in path.split("%")[1:]]


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


def _matching(text: str, i: int) -> int:
    """Return the index just past a balanced () or [] group starting at i."""
    open_ch = text[i]
    close_ch = ")" if open_ch == "(" else "]"
    depth = 0
    n = len(text)
    while i < n:
        if text[i] == open_ch:
            depth += 1
        elif text[i] == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def _read_path(text: str, i: int) -> tuple[str, int, list[str]]:
    """Read one component chain, returning (path, end, subscript paths).

    Handles array sections on *every* component, including nested subscripts:
    ``p_nh_state(jg)%prog(ntl)%w(jc,jk,jb)`` -> ``p_nh_state%prog%w`` plus the
    index-expression paths ``jg``, ``ntl``, ``jc``, ``jk``, ``jb``.
    """
    comps: list[str] = []
    inner: list[str] = []
    n = len(text)
    while True:
        comp, i = _read_component(text, i)
        if not comp:
            break
        comps.append(comp)
        # Consume any number of subscript/section groups attached to this
        # component and recurse into their expressions.
        while i < n and text[i] in "([":
            end = _matching(text, i)
            inner.extend(scan_paths(text[i + 1:end - 1]))
            i = end
        k = i
        while k < n and text[k].isspace():
            k += 1
        if k < n and text[k] == "%":
            i = k + 1
            continue
        break
    return ("%".join(comps), i, inner)


def scan_paths(text: str) -> list[str]:
    """All access paths in ``text`` (subscript expressions included)."""
    out: list[str] = []
    i = 0
    n = len(text or "")
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


def normalize_path(text: str) -> str | None:
    """Extract the first normalised ``a%b%c`` path from source text.

    Array indices are dropped on every component, so
    ``p(jg)%x(je)`` and ``p(jg)%y(ntl)%z`` both keep their full component
    chain.
    """
    paths = scan_paths(text or "")
    return paths[0] if paths else None


def path_chain(text: str) -> list[str]:
    p = normalize_path(text)
    return p.split("%") if p else []


def empty_facts(file: str, rel_path: str, lang: str, profile: str, tier: str) -> dict:
    return {
        "schema": SCHEMA_VERSION,
        "file": file,
        "rel_path": rel_path,
        "lang": lang,
        "profile": profile,
        "tier": tier,
        "parser_ok": True,
        "diagnostics": [],
        "modules": [],
        "procedures": [],
        "types": [],
        "module_vars": [],
        "directives": [],
        "errors": [],
    }
