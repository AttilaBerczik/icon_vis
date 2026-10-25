"""Linker: resolve static calls, type-bound dispatch, bind(c) and callbacks."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .facts import FORTRAN_INTRINSICS
from .symtab import SymbolTable

_STD_NAMES = {
    "printf", "fprintf", "memcpy", "memset", "malloc", "free", "assert", "abort",
    "std", "cout", "cerr", "vector", "string", "size", "max", "min", "abs",
    "sqrt", "pow", "exp", "log", "sin", "cos", "tan", "is_same", "enable_if",
    "move", "forward", "make_unique", "make_shared", "unique_ptr", "shared_ptr",
}
_CUDA_NAMES = {"cudaMalloc", "cudaMemcpy", "cudaFree", "hipMalloc", "hipMemcpy", "hipFree"}
_KOKKOS_NAMES = {
    "deep_copy", "create_mirror_view", "create_mirror_view_and_copy",
    "kokkos_initialize", "kokkos_finalize", "parallel_for", "parallel_reduce",
    "parallel_scan", "fence", "kokkos::initialize", "kokkos::finalize",
    "kokkos_is_initialized", "default_execution_space",
}

_MISSING_LIB_HINTS = [
    ("mpi", "mpi"), ("yaxt", "yaxt"), ("mtime", "mtime"), ("cdi", "cdi"),
    ("netcdf", "netcdf"), ("hdf5", "hdf5"), ("kokkos", "kokkos"),
    ("yac", "yac"), ("ecrad", "ecrad"), ("jsbach", "jsbach"), ("art", "art"),
    ("iconmath", "iconmath"), ("fortran_support", "fortran-support"),
    ("mo_math", "iconmath"), ("ppm", "ppm"), ("sct", "sct"), ("tixi", "tixi"),
]


@dataclass
class CallSite:
    caller: str
    callee: str
    line: int
    kind: str = "call"  # call | dispatch | bindc | callback | external
    virtual: bool = False
    args: list[dict] = field(default_factory=list)
    receiver: str | None = None
    library: str | None = None
    detail: str | None = None


@dataclass
class LinkResult:
    calls: dict[str, list[CallSite]] = field(default_factory=dict)
    stubs: dict[str, dict] = field(default_factory=dict)
    unresolved: list[dict] = field(default_factory=list)
    weights: dict[tuple[str, str], int] = field(default_factory=dict)
    callbacks: list[dict] = field(default_factory=list)
    bindc_links: list[dict] = field(default_factory=list)
    fortran_to_cpp: list[dict] = field(default_factory=list)


def _guess_library(name: str, module_hint: str | None = None) -> str:
    low = (name or "").lower()
    if module_hint:
        return module_hint
    for needle, lib in _MISSING_LIB_HINTS:
        if needle in low:
            return lib
    return "external"


def _decl_map(proc: dict) -> dict[str, dict]:
    out = {}
    for d in proc.get("decls", []) + proc.get("params", []):
        out.setdefault(d["name"], d)
    return out


def _module_var_type(sym: SymbolTable, proc: dict, root: str) -> dict | None:
    mod = proc.get("module")
    vars_ = sym.module_vars.get(mod or "", {})
    if root in vars_:
        return vars_[root]
    for use in sym.visible_uses(mod):
        used = use.get("module")
        only = use.get("only")
        if only is not None and root not in only:
            continue
        orig = only[root] if only is not None else root
        if orig in sym.module_vars.get(used, {}):
            return sym.module_vars[used][orig]
    return None


def _resolve_type_name(sym: SymbolTable, proc: dict, name: str) -> str:
    name = (name or "").lower()
    if sym.type_info(name):
        return name
    resolved, _ = sym.resolve_import(proc.get("module"), name)
    if sym.type_info(resolved):
        return resolved
    return name


def _fortran_targets(sym: SymbolTable, proc: dict, name: str, module_hint: str | None = None) -> list[str]:
    ids = sym.find_procs(name, proc.get("module"), proc.get("id"), module_hint)
    if not ids:
        # USE rename: local name may map to an original procedure name.
        orig, used = sym.resolve_import(proc.get("module"), name)
        if orig != name:
            ids = sym.find_procs(orig, proc.get("module"), proc.get("id"), used)
    # Bind(c) C++ implementation.
    if not ids and name in sym.bind_c:
        ids = sym.bind_c[name]
    return list(dict.fromkeys(ids))


def _explicit_use_module(sym: SymbolTable, proc: dict, local: str) -> str | None:
    """If a name comes from a missing module via USE ONLY, return that module."""
    for use in sym.visible_uses(proc.get("module")):
        mod = use.get("module")
        if mod in sym.modules:
            continue
        only = use.get("only")
        if only is not None and local in only:
            return mod
        if only is None:
            return mod
    return None


def _resolve_fortran_call(sym: SymbolTable, proc: dict, designator: str,
                          args: list[dict]) -> tuple[list[tuple[str, str, bool]], str | None]:
    """Return ([(callee_id, kind, virtual)], stub_library_hint)."""
    designator = designator.lower()
    if "%" in designator:
        parts = designator.split("%")
        method = parts[-1]
        base = "%".join(parts[:-1])
        root = parts[0]
        decls = _decl_map(proc)
        decl = decls.get(root) or _module_var_type(sym, proc, root)
        type_name = _resolve_type_name(sym, proc, decl["type"]) if decl else ""
        is_class = bool((decl or {}).get("class"))
        if type_name and sym.type_info(type_name):
            targets = list(sym.binding_targets(type_name, method))
            if is_class or not targets:
                for sub in sym.subtypes(type_name):
                    for b in sym.bindings.get(sub, []):
                        if b.get("name") != method:
                            continue
                        if b.get("target"):
                            targets.append(b["target"])
                        targets.extend(b.get("generic") or [])
            module_hint = (sym.type_info(type_name) or {}).get("module")
            ids: list[str] = []
            for t in targets:
                ids.extend(_fortran_targets(sym, proc, t, module_hint))
                if not _fortran_targets(sym, proc, t, module_hint):
                    ids.extend(sym.proc_by_name.get(t, []))
            ids = list(dict.fromkeys(ids))
            if ids:
                virtual = is_class or len(ids) > 1
                return [(i, "dispatch" if virtual else "call", virtual) for i in ids], None
            return [], f"type-bound method {method} on {type_name}"
        # Unknown receiver type: fall back to all same-named procedures.
        ids = sym.proc_by_name.get(method, [])
        if ids:
            return [(i, "dispatch", len(ids) > 1) for i in ids], None
        return [], method
    name = designator
    if name in FORTRAN_INTRINSICS:
        return [], None
    ids = _fortran_targets(sym, proc, name)
    if ids:
        return [(i, "call", False) for i in ids], None
    hint = _explicit_use_module(sym, proc, name)
    return [], hint or name


def _resolve_cpp_call(sym: SymbolTable, proc: dict, callee: str, receiver: str | None,
                      scope: str | None) -> list[tuple[str, str, bool]]:
    callee = (callee or "").lower()
    decls = _decl_map(proc)
    targets: list[str] = []
    if receiver:
        root = receiver.split("%")[0]
        if root in ("this", "self"):
            # Class scope is the second-to-last component of the qualified id.
            q = proc.get("qualified") or ""
            parts = q.split("::")
            type_name = parts[-2].lower() if len(parts) > 1 else ""
        else:
            d = decls.get(root)
            type_name = (d or {}).get("type", "").split("::")[-1].lower()
        if type_name and sym.type_info(type_name):
            for sub in [type_name, *sym.subtypes(type_name)]:
                for b in sym.bindings.get(sub, []):
                    if b.get("name") != callee:
                        continue
                    if b.get("target"):
                        targets.extend(sym.cpp_by_name.get(b["target"], []))
                    for g in b.get("generic") or []:
                        targets.extend(sym.cpp_by_name.get(g, []))
        if not targets:
            targets = sym.cpp_by_name.get(callee, [])
    else:
        if scope:
            full = f"{scope}::{callee}" if scope != "std" else callee
            targets = [i for i in sym.cpp_by_name.get(callee, [])
                       if f"::{scope}::" in i or i.startswith(f"cpp:{scope}::")]
        if not targets:
            targets = sym.cpp_by_name.get(callee, [])
    # C++ -> Fortran through an extern "C" name.
    if not targets and callee in sym.bind_c:
        targets = sym.bind_c[callee]
    return [(i, "call", False) for i in targets]


def link(sym: SymbolTable) -> LinkResult:
    res = LinkResult()
    weights: dict[tuple[str, str], int] = {}

    for pid, proc in sym.procs.items():
        sites: list[CallSite] = []
        for stmt in proc.get("stmts", []):
            if stmt.get("op") != "call":
                continue
            callee = stmt.get("callee", "")
            line = stmt.get("line", 0)
            args = stmt.get("args", [])
            if proc.get("lang") == "cpp":
                targets = _resolve_cpp_call(sym, proc, callee, stmt.get("receiver"), stmt.get("scope"))
                if not targets:
                    low = callee.lower()
                    scope = (stmt.get("scope") or "").lower()
                    if low in _KOKKOS_NAMES or scope.startswith("kokkos"):
                        lib = "kokkos"
                    elif low in _CUDA_NAMES or low.startswith(("cudamem", "hipmem")) or scope in ("cuda", "hip"):
                        lib = "cuda"
                    elif low in _STD_NAMES or scope == "std":
                        lib = "std"
                    else:
                        lib = _guess_library(callee)
                    targets = [(f"ext:{lib}:{callee}", "external", False)]
            else:
                targets, hint = _resolve_fortran_call(sym, proc, callee, args)
                if not targets:
                    if hint is None:
                        continue  # intrinsic / ignored
                    lib = _guess_library(hint, hint if hint.startswith(("mo_", "mpi", "yaxt", "mtime")) else None)
                    stub = f"ext:{lib}:{callee.split('%')[-1]}"
                    targets = [(stub, "external", False)]
                    if not any(u["caller"] == pid and u["callee"] == callee and u["line"] == line
                               for u in res.unresolved):
                        res.unresolved.append({
                            "caller": pid, "callee": callee, "line": line,
                            "library": lib, "reason": "no definition in source tree",
                        })
            # Callbacks: c_funloc(proc) passed as an actual argument.
            for a in args:
                for m in re.finditer(r"c_funloc\s*\(\s*([A-Za-z_]\w*)", a.get("expr", ""), re.I):
                    cb = m.group(1).lower()
                    cb_ids = _fortran_targets(sym, proc, cb)
                    for cid in cb_ids:
                        csite = CallSite(caller=pid, callee=cid, line=line, kind="callback",
                                         args=[], detail=f"c_funloc({cb})")
                        sites.append(csite)
                        res.callbacks.append({"caller": pid, "target": cid, "via": callee, "line": line})
            for target, kind, virtual in targets:
                site = CallSite(caller=pid, callee=target, line=line, kind=kind,
                                virtual=virtual, args=args,
                                receiver=stmt.get("receiver"), library=None,
                                detail=(stmt.get("text") or "")[:200])
                sites.append(site)
                weights[(pid, target)] = weights.get((pid, target), 0) + 1
                if target.startswith("ext:"):
                    lib = target.split(":")[1] if target.count(":") >= 2 else "external"
                    res.stubs[target] = {"id": target, "name": target.split(":")[-1],
                                         "library": lib, "kind": "external"}
        if sites:
            res.calls[pid] = sites

    res.weights = weights

    # bind(c) links: Fortran implementation <-> C++ routine / runtime.
    for fc_name, pids in sym.bind_c.items():
        for pid in pids:
            cpp = sym.cpp_by_name.get(fc_name, [])
            if cpp:
                for cid in cpp:
                    res.bindc_links.append({"fortran": pid, "cpp": cid, "kind": "bindc",
                                            "name": fc_name})
                    res.fortran_to_cpp.append({"from": pid, "to": cid, "kind": "bindc"})
                    res.calls.setdefault(pid, []).append(
                        CallSite(caller=pid, callee=cid, line=sym.procs[pid].get("line", 0),
                                 kind="bindc")
                    )
                    weights[(pid, cid)] = max(1, weights.get((pid, cid), 0))
            else:
                lib = _guess_library(fc_name, "c-runtime")
                stub = f"ext:{lib}:{fc_name}"
                res.stubs.setdefault(stub, {"id": stub, "name": fc_name, "library": lib,
                                           "kind": "bindc-external"})
                res.bindc_links.append({"fortran": pid, "cpp": stub, "kind": "bindc",
                                        "name": fc_name})
                res.calls.setdefault(pid, []).append(
                    CallSite(caller=pid, callee=stub, line=sym.procs[pid].get("line", 0),
                             kind="bindc")
                )
                weights[(pid, stub)] = max(1, weights.get((pid, stub), 0))
    res.weights = weights
    return res
