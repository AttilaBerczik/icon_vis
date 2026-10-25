"""Inter-procedural propagation over the resolved call graph.

Summaries are per function (entity -> read/write mode). A worklist over reverse
call edges reaches a fixpoint; callee effects on formals are mapped back onto
caller actuals, while module-variable effects propagate unchanged.
"""

from __future__ import annotations

from collections import defaultdict, deque

from .linker import LinkResult
from .paths import PathResolver
from .symtab import SymbolTable

_MODE_RANK = {"read": 1, "write": 2, "readwrite": 3}
_RANK_MODE = {1: "read", 2: "write", 3: "readwrite"}


def _combine(*modes: str) -> str:
    rank = max((_MODE_RANK.get(m, 0) for m in modes if m), default=0)
    return _RANK_MODE.get(rank, "read")


def _aggregate(accesses: list[dict]) -> dict[str, str]:
    out: dict[str, str] = {}
    for a in accesses:
        entity = a["entity"]
        out[entity] = _combine(out.get(entity, ""), a["mode"])
    return out


def _callee_param_index(callee: dict) -> dict[str, int]:
    return {p["name"]: i for i, p in enumerate(callee.get("params", []))}


def _map_actual_arg(args: list[dict], idx: int, param: str) -> dict | None:
    if idx < len(args) and args[idx].get("keyword") is None:
        return args[idx]
    for a in args:
        if a.get("keyword") == param:
            return a
    if idx < len(args):
        return args[idx]
    return None


class InterprocResult:
    def __init__(self):
        self.summaries: dict[str, dict[str, str]] = {}
        self.accesses: dict[str, list[dict]] = {}
        self.passes: list[dict] = []
        self.iterations = 0


def propagate(sym: SymbolTable, linker: LinkResult, direct_accesses: dict[str, list[dict]]) -> InterprocResult:
    res = InterprocResult()
    callers_of: dict[str, dict[str, list[tuple[str, object]]]] = defaultdict(lambda: defaultdict(list))
    for caller, sites in linker.calls.items():
        for site in sites:
            callers_of[site.callee][caller].append((caller, site))

    # Per-call maps from callee parameter name to caller actual path.
    def caller_resolver(caller: str) -> PathResolver:
        return PathResolver(sym, sym.procs[caller])

    resolvers: dict[str, PathResolver] = {}
    # Base summaries.
    summaries = {pid: _aggregate(acc) for pid, acc in direct_accesses.items()}
    final_accesses = {pid: list(acc) for pid, acc in direct_accesses.items()}
    passes: list[dict] = []

    queue: deque[str] = deque(summaries.keys())
    queued = set(summaries.keys())
    iterations = 0
    # `iterations` counts worklist pops; a hard cap that is too small silently
    # truncates propagation. Bound it by the number of call sites instead.
    max_pops = max(1000, 10 * (len(sym.procs) + len(linker.weights)))
    while queue and iterations < max_pops:
        iterations += 1
        caller = queue.popleft()
        queued.discard(caller)
        if caller not in sym.procs:
            continue
        proc = sym.procs[caller]
        acc = list(direct_accesses.get(caller, []))
        new_passes = []
        for site in linker.calls.get(caller, []):
            callee = site.callee
            cproc = sym.procs.get(callee)
            csum = summaries.get(callee, {}) if cproc else {}
            if not cproc:
                # External stub: conservatively treat the actual arguments as
                # reads at the call site. Do NOT do this for in-tree callees
                # with an empty summary; in a call cycle it would inject reads
                # and prevent the worklist from converging quickly.
                parser = resolvers.setdefault(caller, caller_resolver(caller))
                for actual in site.args:
                    for p in actual.get("paths", []):
                        rp = parser.resolve(p, caller)
                        if rp.root_kind == "unknown":
                            continue
                        acc.append({
                            "entity": rp.entity, "path": rp.path, "root": rp.root,
                            "root_kind": rp.root_kind, "type": rp.type, "mode": "read",
                            "line": site.line, "via": f"call:{callee}", "proc": caller,
                            "file": proc.get("file"), "lang": proc.get("lang"),
                            "scope": rp.scope, "propagated": True,
                        })
                continue
            if not csum:
                continue
            idx_map = _callee_param_index(cproc)
            parser = resolvers.setdefault(caller, caller_resolver(caller))
            callee_entities = {a["entity"]: a for a in direct_accesses.get(callee, [])}
            # Use the callee's current summary (including propagated effects).
            for entity, mode in csum.items():
                a = callee_entities.get(entity)
                if a is None:
                    # Propagated or module/global effect; keep entity unchanged.
                    if entity.startswith(("param:", "local:", "this:")):
                        continue
                    acc.append({
                        "entity": entity, "path": entity.split(":", 1)[-1],
                        "root": "", "root_kind": "module", "type": None,
                        "mode": mode, "line": site.line, "via": f"call:{callee}",
                        "proc": caller, "file": proc.get("file"), "lang": proc.get("lang"),
                        "scope": proc.get("module"), "propagated": True,
                    })
                    continue
                root = a.get("root")
                if a.get("root_kind") == "param":
                    idx = idx_map.get(root, -1)
                    actual = _map_actual_arg(site.args, idx, root) if idx >= 0 else None
                    if actual is None or not actual.get("path"):
                        continue
                    fields = a["path"].split("%")[1:]
                    mapped = actual["path"] + (("%" + "%".join(fields)) if fields else "")
                elif a.get("root_kind") == "this" and site.receiver:
                    mapped = site.receiver + a["path"][len("this"):]
                else:
                    # Module/global entity: same entity remains affected.
                    if entity.startswith(("var:", "field:", "global:")):
                        acc.append({**a, "proc": caller, "line": site.line,
                                    "via": f"call:{callee}", "propagated": True})
                    continue
                root_m = mapped.split("%", 1)[0]
                rp = parser.resolve(mapped, caller)
                if rp.root_kind == "unknown":
                    continue
                new_passes.append({
                    "caller": caller, "callee": callee, "line": site.line,
                    "formal": f"param:{callee}::{root}" if a.get("root_kind") == "param" else entity,
                    "actual": rp.entity, "mode": mode,
                })
                acc.append({
                    "entity": rp.entity, "path": rp.path, "root": rp.root,
                    "root_kind": rp.root_kind, "type": rp.type, "mode": mode,
                    "line": site.line, "via": f"call:{callee}", "proc": caller,
                    "file": proc.get("file"), "lang": proc.get("lang"),
                    "scope": rp.scope, "propagated": True,
                })
        # Deduplicate accesses by (entity, line, via, mode).
        uniq: dict[tuple, dict] = {}
        for a in acc:
            uniq[(a["entity"], a.get("line"), a.get("via"), a.get("mode"))] = a
        acc = list(uniq.values())
        new_summary = _aggregate(acc)
        if new_summary != summaries.get(caller, {}):
            summaries[caller] = new_summary
            final_accesses[caller] = acc
            passes.extend(new_passes)
            for other, _sites in callers_of.get(caller, {}).items():
                if other not in queued:
                    queued.add(other)
                    queue.append(other)
        else:
            # Keep any additional accesses discovered this round.
            final_accesses[caller] = acc
            if new_passes:
                passes.extend(new_passes)
    res.summaries = summaries
    res.accesses = final_accesses
    res.iterations = iterations
    # Deduplicate passes and cap output.
    seen = set()
    unique = []
    for p in passes:
        k = (p["caller"], p["callee"], p["line"], p["actual"], p["mode"])
        if k in seen:
            continue
        seen.add(k)
        unique.append(p)
    res.passes = unique
    return res
