"""Preprocessing for Fortran (GCC cpp) and C++ (pcpp).

Fortran output keeps ``# line`` markers so the caller can build a
:class:`~dataflow.linemap.LineMap` and report original file/line locations,
including code pulled from ``.inc`` files. C++ includes are passed through
(parsed only for macro state) because every header is also a manifest entry;
this avoids duplicated facts and keeps per-file analysis cheap.
"""

from __future__ import annotations

import io
import os
import re
import subprocess
from dataclasses import dataclass, field

import pcpp

from .linemap import LineMap, build_line_map

DEFAULT_TIMEOUT = 120


@dataclass
class Preprocessed:
    text: str
    linemap: LineMap
    tool: str
    diagnostics: list[str] = field(default_factory=list)
    ok: bool = True


def _include_dirs(path: str, model_root: str | None, extra_include_dirs: list[str]) -> list[str]:
    dirs: list[str] = []
    dirs.append(os.path.dirname(path))
    if model_root:
        dirs.extend([
            os.path.join(model_root, "src", "include"),
            os.path.join(model_root, "src", "templates"),
        ])
    dirs.extend(extra_include_dirs)
    out: list[str] = []
    seen = set()
    for d in dirs:
        if d and os.path.isdir(d) and os.path.abspath(d) not in seen:
            seen.add(os.path.abspath(d))
            out.append(os.path.abspath(d))
    return out


def preprocess_fortran(
    path: str,
    cpp_args: list[str],
    model_root: str | None = None,
    extra_include_dirs: list[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Preprocessed:
    cmd = ["cpp", "-traditional-cpp", "-w", "-nostdinc", *cpp_args]
    for d in _include_dirs(path, model_root, extra_include_dirs or []):
        cmd.extend(["-I", d])
    cmd.append(path)
    diags: list[str] = []
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, errors="replace", timeout=timeout
        )
        raw = proc.stdout
        if proc.returncode != 0:
            tail = proc.stderr.strip().splitlines()
            diags.append("cpp: " + (tail[-1][:300] if tail else f"rc={proc.returncode}"))
    except (subprocess.TimeoutExpired, OSError) as exc:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        diags.append(f"cpp failed ({type(exc).__name__}); raw fallback")
        text, lm = build_line_map(raw, path)
        return Preprocessed(text, lm, "raw", diags, ok=False)

    if not raw.strip():
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        diags.append("empty cpp output; raw fallback")
        text, lm = build_line_map(raw, path)
        return Preprocessed(text, lm, "raw", diags, ok=False)

    text, lm = build_line_map(raw, path)
    return Preprocessed(text, lm, "cpp", diags, ok=True)


class _PCpp(pcpp.Preprocessor):
    def __init__(self):
        super().__init__()
        self.diagnostics: list[str] = []
        self.line_directive = "#line"
        self.passthru_includes = re.compile(r".*")

    def on_error(self, file, line, msg):  # noqa: A003 - pcpp hook name
        if len(self.diagnostics) < 40:
            self.diagnostics.append(f"{file}:{line}: {msg}")
        self.return_code += 1

    def on_include_not_found(self, is_malformed, is_system_include, curdir, includepath):
        raise pcpp.OutputDirective(pcpp.Action.IgnoreAndPassThrough)


def preprocess_cpp(
    path: str,
    defines: dict[str, object] | None = None,
    undefines: list[str] | None = None,
    model_root: str | None = None,
    extra_include_dirs: list[str] | None = None,
) -> Preprocessed:
    with open(path, encoding="utf-8", errors="replace") as fh:
        src = fh.read()
    pp = _PCpp()
    for d in _include_dirs(path, model_root, extra_include_dirs or []):
        pp.add_path(d)
    for key, value in (defines or {}).items():
        if value is None or value is True:
            pp.define(key)
        else:
            pp.define(f"{key} {value}")
    for key in undefines or []:
        pp.undef(key)
    try:
        pp.parse(src, source=path)
        buf = io.StringIO()
        pp.write(buf)
        raw = buf.getvalue()
    except Exception as exc:  # pcpp is best-effort; raw + masks still parses
        raw = src
        pp.diagnostics.append(f"pcpp failed ({type(exc).__name__}: {exc}); raw fallback")
    if not raw:
        raw = src
    text, lm = build_line_map(raw, path)
    ok = not any("not found" in d or "failed" in d for d in pp.diagnostics)
    return Preprocessed(text, lm, "pcpp", pp.diagnostics, ok=ok)
