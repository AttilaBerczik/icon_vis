"""Scanner for ``!$ACC`` / ``!$OMP`` / ``#pragma`` directives.

Directives are comments to the Fortran parser, so they are extracted directly
from the preprocessed source, including ``!$ACC&`` continuations. Every clause
that carries data paths is parsed into ``(clause, [paths])``.
"""

from __future__ import annotations

import re

from .facts import normalize_path
from .linemap import LineMap

_DIRECTIVE = re.compile(r"^\s*(?:!\$(acc|omp)|#\s*pragma\s+(acc|omp|kokkos))\b(.*)$", re.I)
_CONT = re.compile(r"^\s*(?:!\$(?:acc|omp)\s*&|#\s*pragma\s+\w+\s*&)\s*(.*)$", re.I)

# Directive words (the first one is the "directive", the rest are modifiers).
_DIRECTIVE_WORDS = {
    "PARALLEL", "KERNELS", "SERIAL", "LOOP", "PARALLEL_LOOP", "DATA", "ENTER",
    "EXIT", "UPDATE", "ROUTINE", "WAIT", "SET", "DECLARE", "CACHE", "ATOMIC",
    "HOST_DATA", "TILE", "TARGET", "TEAMS", "DISTRIBUTE", "SIMD", "PARALLEL DO",
}

_DATA_CLAUSES = {
    "COPY", "COPYIN", "COPYOUT", "CREATE", "DELETE", "PRESENT", "DEVICE",
    "HOST", "DEVICEPTR", "PRIVATE", "FIRSTPRIVATE", "LASTPRIVATE", "SHARED",
    "REDUCTION", "CACHE", "USE_DEVICE", "ATTACH", "DETACH", "NO_CREATE",
    "ZERO", "SELF", "LINK", "MAP",
}

_CLAUSE_RE = re.compile(r"^([A-Za-z_][\w]*)\s*(?:\((.*)\))?$", re.S)
_PATH_RE = re.compile(r"[A-Za-z_]\w*(?:\s*%\s*[A-Za-z_]\w*)*")


def _split_top(s: str, sep: str = ",") -> list[str]:
    out, depth, cur = [], 0, []
    for ch in s:
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == sep and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        out.append("".join(cur))
    return [x.strip() for x in out if x.strip()]


def _paths_from_var_list(vars_text: str) -> list[str]:
    paths = []
    for item in _split_top(vars_text):
        # REDUCTION(+:a,b) / CACHE(a,b)
        if ":" in item and not item.startswith(":"):
            item = item.split(":", 1)[1]
        path = normalize_path(item)
        if path:
            paths.append(path)
    return paths


def _parse_clauses(rest: str) -> list[dict]:
    clauses: list[dict] = []
    # Tokenise on whitespace at paren depth 0.
    tokens, depth, cur = [], 0, []
    for ch in rest:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch.isspace() and depth == 0:
            if cur:
                tokens.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    if cur:
        tokens.append("".join(cur))

    for token in tokens:
        token = token.strip()
        if not token:
            continue
        m = _CLAUSE_RE.match(token)
        if not m:
            clauses.append({"clause": token.upper(), "vars": [], "args": ""})
            continue
        name = m.group(1).upper()
        args = (m.group(2) or "").strip()
        if name in _DATA_CLAUSES:
            clauses.append({
                "clause": name,
                "vars": _paths_from_var_list(args),
                "args": args,
            })
        else:
            clauses.append({"clause": name, "vars": [], "args": args})
    return clauses


def scan_directives(text: str, linemap: LineMap) -> list[dict]:
    lines = text.splitlines()
    directives: list[dict] = []
    i = 0
    while i < len(lines):
        m = _DIRECTIVE.match(lines[i])
        if not m:
            i += 1
            continue
        kind = (m.group(1) or m.group(2) or "").lower()
        body = m.group(3).strip()
        start = i + 1
        raw_lines = [lines[i].strip()]
        # Continuations: !$ACC& / #pragma acc & ...
        while i + 1 < len(lines):
            cm = _CONT.match(lines[i + 1])
            if not cm:
                break
            i += 1
            body = body.rstrip()
            if body.endswith("&"):
                body = body[:-1]
            body += " " + cm.group(1).strip()
            raw_lines.append(lines[i].strip())
        i += 1

        body = body.strip().rstrip("&").strip()
        # Split directive words from clauses: leading bare words.
        words: list[str] = []
        rest = body
        while True:
            wm = re.match(r"^([A-Za-z_]+)\s*(.*)$", rest, re.S)
            if not wm:
                break
            word = wm.group(1).upper()
            if word in _DIRECTIVE_WORDS:
                words.append(word)
                rest = wm.group(2)
                continue
            break
        directive = words[0] if words else (body.split()[0].upper() if body else "")
        rest = rest if words else body
        file, line = linemap.get(start)
        directives.append({
            "kind": kind,
            "directive": directive,
            "modifiers": words[1:],
            "clauses": _parse_clauses(rest),
            "line": line,
            "file": file,
            "raw": " ".join(raw_lines),
            "space": _space_for(kind, words),
        })
    return directives


def _space_for(kind: str, words: list[str]) -> str:
    if kind == "omp":
        return "host"
    if kind != "acc":
        return "host"
    if not words:
        return "host"
    d = words[0]
    if d in ("PARALLEL", "KERNELS", "SERIAL", "PARALLEL_LOOP"):
        return "device"
    if d == "ROUTINE":
        return "host_device"
    if d in ("LOOP", "ATOMIC", "CACHE"):
        return "device"
    return "host"
