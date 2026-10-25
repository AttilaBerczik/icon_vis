"""Execution-space and OpenACC/OpenMP signal analysis."""

from __future__ import annotations

import re
from collections import defaultdict

from .symtab import SymbolTable

_LATTICE = {"host", "device", "host_device", "switchable"}


def _merge_spaces(spaces: set[str]) -> str:
    if not spaces:
        return "unknown"
    if "switchable" in spaces:
        return "switchable"
    if "device" in spaces and "host" in spaces:
        return "host_device"
    if "device" in spaces:
        return "device"
    if "host_device" in spaces and "device" in spaces:
        return "host_device"
    if "host_device" in spaces:
        return "host_device"
    if "device" in spaces:
        return "device"
    if "host" in spaces:
        return "host"
    return "unknown"


def _directive_space(d: dict) -> str:
    if d.get("kind") == "omp":
        return "host"
    if d.get("kind") != "acc":
        return "host"
    directive = (d.get("directive") or "").upper()
    modifiers = [m.upper() for m in d.get("modifiers", [])]
    if directive == "ROUTINE":
        return "host_device"
    if directive in ("PARALLEL", "KERNELS", "SERIAL", "PARALLEL_LOOP"):
        return "device"
    if directive in ("LOOP", "ATOMIC", "CACHE"):
        return "device"
    if directive in ("ENTER", "EXIT", "UPDATE"):
        return "host"  # data movement, not kernel execution
    if directive == "DATA":
        return "host"
    if "LOOP" in modifiers and directive == "PARALLEL":
        return "device"
    return "host"


def _is_conditional(d: dict) -> bool:
    for clause in d.get("clauses", []):
        if clause.get("clause") == "IF":
            args = (clause.get("args") or "").lower()
            return bool(re.search(r"\b(lacc|lzacc|on_gpu|use_gpu)\b", args))
    return False


def _regions(directives: list[dict]) -> list[tuple[int, int, str]]:
    """Build line intervals for device/host regions from ACC/OpenMP directives."""
    regions: list[tuple[int, int, str]] = []
    open_stack: list[tuple[int, str]] = []
    max_line = max((d["line"] for d in directives), default=0) + 1_000_000
    for d in sorted(directives, key=lambda x: x["line"]):
        directive = (d.get("directive") or "").upper()
        space = _directive_space(d)
        if directive == "END":
            if open_stack:
                start, sp = open_stack.pop()
                regions.append((start, d["line"], sp))
            continue
        if directive in ("PARALLEL", "KERNELS", "SERIAL", "PARALLEL_LOOP", "DATA", "HOST_DATA"):
            open_stack.append((d["line"], space))
        elif directive == "LOOP" and not open_stack:
            # Standalone loop directive: approximate a small region.
            regions.append((d["line"], d["line"] + 5000, "device"))
    for start, sp in open_stack:
        regions.append((start, max_line, sp))
    return regions


def apply(sym: SymbolTable, file_facts: list[dict], accesses: dict[str, list[dict]]) -> dict:
    directives_by_file: dict[str, list[dict]] = defaultdict(list)
    for f in file_facts:
        directives_by_file[f.get("file")].extend(f.get("directives", []))

    exec_by_proc: dict[str, str] = {}
    proc_directives: dict[str, list[dict]] = defaultdict(list)
    proc_regions: dict[str, list[tuple[int, int, str]]] = {}
    exec_details: dict[str, dict] = {}

    for pid, proc in sym.procs.items():
        f = proc.get("file")
        lo, hi = proc.get("line", 0), proc.get("end_line", proc.get("line", 0))
        dirs = [d for d in directives_by_file.get(f, []) if lo <= d.get("line", 0) <= hi]
        # Include directives that came from an included .inc file: if there are
        # no file matches, accept directives between the proc lines regardless.
        if not dirs and proc.get("lang") == "fortran":
            dirs = [d for d in directives_by_file.get(f, []) if lo <= d.get("line", 0) <= hi]
        proc_directives[pid] = dirs
        spaces: set[str] = set()
        signals: list[str] = []
        switch_flag = None
        for d in dirs:
            directive = (d.get("directive") or "").upper()
            # Data movement / END / WAIT directives do not say where code runs.
            exec_directive = (
                d.get("kind") == "omp"
                or directive in ("PARALLEL", "KERNELS", "SERIAL", "PARALLEL_LOOP",
                                  "LOOP", "ROUTINE", "ATOMIC")
            )
            if exec_directive:
                sp = _directive_space(d)
                if sp in _LATTICE:
                    spaces.add(sp)
                signals.append(f"{d.get('kind')}:{directive}")
            if _is_conditional(d) and exec_directive:
                switch_flag = switch_flag or "lacc"

        # Explicit contracts / runtime switches.
        for stmt in proc.get("stmts", []):
            if stmt.get("op") != "call":
                continue
            callee = (stmt.get("callee") or "").lower()
            if callee in ("set_acc_host_or_device", "set_acc_host_or_device_", "lacc_set"):
                spaces.add("switchable")
                switch_flag = switch_flag or "lacc"
                signals.append("set_acc_host_or_device")
            elif callee in ("assert_acc_device_only", "assert_acc_device_only_"):
                spaces.add("device")
                signals.append("assert_acc_device_only")
            elif callee in ("assert_acc_host_only", "assert_acc_host_only_"):
                spaces.add("host")
                signals.append("assert_acc_host_only")
            for a in stmt.get("args", []):
                if (a.get("keyword") or "") in ("lacc", "lzacc"):
                    switch_flag = switch_flag or "lacc"
                    spaces.add("switchable")

        # C++ Kokkos/CUDA markers.
        for m in proc.get("exec_markers", []):
            sp = m.get("space")
            if sp in _LATTICE:
                spaces.add(sp)
                signals.append(m.get("macro") or "")
        # Kokkos default execution space / UseGPU in the body.
        body_text = " ".join(s.get("text", "") for s in proc.get("stmts", []))
        if re.search(r"\bUseGPU\b|\bisGPU\b|\bDefaultExecutionSpace\b", body_text):
            spaces.add("device")
            signals.append("kokkos-space")
        if re.search(r"\bDefaultHostExecutionSpace\b", body_text):
            spaces.add("host")

        space = _merge_spaces(spaces)
        if switch_flag and "device" in spaces:
            space = "switchable"
        if space == "unknown":
            space = "host"
        exec_by_proc[pid] = space
        exec_details[pid] = {
            "space": space,
            "signals": sorted(set(signals)),
            "switch_flag": switch_flag,
            "directives": len(dirs),
        }
        proc_regions[pid] = _regions(dirs)

    # Annotate accesses with the region's execution space.
    for pid, accs in accesses.items():
        proc = sym.procs.get(pid, {})
        regions = proc_regions.get(pid, [])
        for a in accs:
            line = a.get("line", 0)
            sp = exec_by_proc.get(pid, "unknown")
            for start, end, rsp in regions:
                if start <= line <= end:
                    sp = rsp
                    break
            a["exec_space"] = sp
            a["proc_exec_space"] = exec_by_proc.get(pid, "unknown")
            a.setdefault("file", proc.get("file"))
            a.setdefault("lang", proc.get("lang"))

    return {
        "exec_by_proc": exec_by_proc,
        "directives": proc_directives,
        "regions": proc_regions,
        "details": exec_details,
    }
