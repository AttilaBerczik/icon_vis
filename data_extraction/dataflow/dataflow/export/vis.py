"""Static viewer export: call graph, parameter shards, search index and traces.

The exporter is deliberately self-contained and works from either

* the in-memory pipeline objects (``extract.py --vis``), or
* ``dataflow.sqlite`` (``vis.py --out data_extraction/out``).

Output (``vis/`` by default, plus ``.br``/``.gz`` copies)::

    graph.json          reachable call graph, integer node ids, string tables
    layout.json         initial ordering (written by build_layout.js)
    fn/<component>.json per-function parameters + lifecycle group ids
    search.json         sorted data-name -> group index
    trace/<xx>.json     precomputed lifecycle per trace group (256 shards)

The browser never computes closure, grouping or program order; it only looks
things up and toggles DOM classes.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field

try:  # optional, but strongly recommended by the viewer build
    import brotli
except Exception:  # pragma: no cover - exercised only on minimal installs
    brotli = None


# --------------------------------------------------------------------------- #
# small utilities
# --------------------------------------------------------------------------- #

DEFAULT_ROOT_ID = "program::icon"

VIA_NAMES = ["assign", "expr", "allocate", "read", "copy", "call", "pass", "decl"]
VIA_INDEX = {name: i for i, name in enumerate(VIA_NAMES)}

ROLE_CREATE = 1
ROLE_WRITE = 2
ROLE_READ = 4
ROLE_PASS = 8

TRACE_SHARDS = 256

KIND_CODE = {"call": 0, "dispatch": 1, "external": 2, "bindc": 3, "callback": 4}
EXT_FLAG = 1
CPP_FLAG = 2
TEST_FLAG = 4


def _norm_intent(value) -> str | None:
    if not value:
        return None
    v = str(value).strip().lower()
    return {"in": "IN", "out": "OUT", "inout": "INOUT"}.get(v, v.upper())


def _entity_kind(entity: str) -> str:
    return entity.split(":", 1)[0] if ":" in entity else "unknown"


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "surrogatepass")).hexdigest()


def _safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text or "unknown").strip("_") or "unknown"


def _rel(path: str | None, root: str | None) -> str:
    if not path:
        return ""
    if root:
        try:
            return os.path.relpath(path, root).replace(os.sep, "/")
        except ValueError:
            pass
    # Keep paths stable across checkouts in the standalone sqlite path.
    p = path.replace("\\", "/")
    marker = "/icon-model/"
    if marker in p:
        return p.split(marker, 1)[-1]
    marker = "/libiconmath-main/"
    if marker in p:
        return p.split(marker, 1)[-1]
    return p.lstrip("/")


def compress_file(path: str) -> dict:
    with open(path, "rb") as fh:
        data = fh.read()
    sizes = {"raw": len(data)}
    gz = gzip.compress(data, compresslevel=9, mtime=0)
    with open(path + ".gz", "wb") as fh:
        fh.write(gz)
    sizes["gz"] = len(gz)
    if brotli is not None:
        br = brotli.compress(data, quality=9)
        with open(path + ".br", "wb") as fh:
            fh.write(br)
        sizes["br"] = len(br)
    return sizes


def _write_json(path: str, obj, compress: bool = True) -> dict:
    data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)
    if compress:
        return compress_file(path)
    return {"raw": len(data)}


# --------------------------------------------------------------------------- #
# truncated types view used by the standalone sqlite path
# --------------------------------------------------------------------------- #

class TypesView:
    """Minimal ``SymbolTable``-compatible type lookup."""

    def __init__(self, rows: list[dict]):
        self.types: dict[str, list[dict]] = defaultdict(list)
        for row in rows:
            fields = row.get("fields") or []
            if isinstance(fields, str):
                try:
                    fields = json.loads(fields)
                except Exception:
                    fields = []
            self.types[row["name"]].append({
                "name": row["name"],
                "module": row.get("module"),
                "extends": row.get("extends"),
                "fields": fields,
            })

    def type_info(self, name: str, module: str | None = None) -> dict | None:
        name = (name or "").lower()
        if module:
            for t in self.types.get(name, []):
                if (t.get("module") or "") == module:
                    return t
        lst = self.types.get(name)
        return lst[0] if lst else None

    def type_chain(self, name: str, module: str | None = None) -> list[dict]:
        chain, seen = [], set()
        cur = (name or "").lower()
        while cur and cur not in seen:
            seen.add(cur)
            t = self.type_info(cur, module if not chain else None)
            if not t:
                break
            chain.append(t)
            cur = (t.get("extends") or "").split("::")[-1].lower()
        return chain


def _find_field(types, owner: str, component: str) -> dict | None:
    for t in types.type_chain(owner):
        for f in t.get("fields", []) or []:
            if (f.get("name") or "").lower() == component:
                return f
    return None


def canonical_field_entity(entity: str, types) -> str:
    """Merge equivalent field paths onto the type that owns the leaf.

    ``field:t_nh_state%prog%rho`` -> ``field:t_nh_prog%rho`` because ``rho``
    is declared by ``t_nh_prog``. Paths that cannot be resolved are returned
    unchanged (never guessed).
    """
    if not entity or not entity.startswith("field:"):
        return entity
    path = entity.split(":", 1)[1]
    parts = [p for p in path.split("%") if p]
    if len(parts) < 2:
        return entity
    owner = parts[0].lower()
    for i in range(1, len(parts)):
        comp = parts[i].lower()
        field_info = _find_field(types, owner, comp)
        if field_info is None:
            return entity
        if i == len(parts) - 1:
            return "field:" + owner + "%" + "%".join(parts[i:])
        next_type = (field_info.get("type") or "").split("::")[-1].lower()
        if not next_type or types.type_info(next_type) is None:
            return entity
        owner = next_type
    return entity


# --------------------------------------------------------------------------- #
# union-find + static order
# --------------------------------------------------------------------------- #

class UnionFind:
    def __init__(self):
        self.parent: dict[str, str] = {}
        self.rank: dict[str, int] = {}

    def add(self, item: str) -> None:
        if item not in self.parent:
            self.parent[item] = item
            self.rank[item] = 0

    def find(self, item: str) -> str:
        self.add(item)
        parent = self.parent
        root = item
        while parent[root] != root:
            root = parent[root]
        while parent[item] != item:
            parent[item], item = root, parent[item]
        return root

    def union(self, a: str, b: str) -> None:
        if not a or not b:
            return
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1

    def groups(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = defaultdict(list)
        for item in self.parent:
            out[self.find(item)].append(item)
        return out


def compute_static_order(root: str, calls: list[dict],
                         functions: dict[str, dict]) -> dict[str, int]:
    """DFS from the program root in call-site-line order.

    The result is the approximate program order used to sort lifecycle events.
    Unreachable functions are appended in source order so every function has a
    sequence number.
    """
    by_caller: dict[str, list[dict]] = defaultdict(list)
    for call in calls:
        by_caller[call["caller"]].append(call)
    for sites in by_caller.values():
        sites.sort(key=lambda c: (c.get("line") or 0, c.get("callee") or ""))

    order: dict[str, int] = {}
    visited: set[str] = set()

    def visit(start: str) -> None:
        stack = [(start, 0)]
        while stack:
            node, idx = stack.pop()
            if idx == 0:
                if node in visited:
                    continue
                visited.add(node)
                order[node] = len(order)
            sites = by_caller.get(node, [])
            while idx < len(sites):
                child = sites[idx].get("callee")
                idx += 1
                if child and child not in visited:
                    stack.append((node, idx))
                    stack.append((child, 0))
                    break

    if root:
        visit(root)
    for pid in sorted(functions, key=lambda p: (functions[p].get("file") or "",
                                                functions[p].get("line") or 0, p)):
        if pid not in visited:
            visit(pid)
    return order


# --------------------------------------------------------------------------- #
# source adapter: pipeline objects
# --------------------------------------------------------------------------- #

def source_from_pipeline(sym, linker, interproc, exec_info, file_meta: dict,
                         model_root: str) -> dict:
    from ..intraproc import aggregate_intents

    functions: dict[str, dict] = {}
    for pid, proc in sym.procs.items():
        all_acc = interproc.accesses.get(pid, [])
        direct = [a for a in all_acc if not a.get("propagated")]
        params = aggregate_intents(proc, direct)
        functions[pid] = {
            "id": pid,
            "name": proc.get("name"),
            "module": proc.get("module"),
            "kind": proc.get("kind"),
            "lang": proc.get("lang"),
            "file": proc.get("file"),
            "line": proc.get("line"),
            "end_line": proc.get("end_line"),
            "params": params,
            "result": proc.get("result"),
            "exec_space": exec_info.get("exec_by_proc", {}).get(pid, "unknown"),
            "aliases": proc.get("aliases", []),
        }
    for stub_id, stub in linker.stubs.items():
        functions.setdefault(stub_id, {
            "id": stub_id, "name": stub.get("name"), "module": None,
            "kind": "external", "lang": "external", "file": None, "line": 0,
            "end_line": 0, "params": [], "result": None, "exec_space": "external",
            "external": True, "library": stub.get("library") or "external",
            "aliases": [],
        })

    calls = []
    for (caller, callee), weight in linker.weights.items():
        sites = [c for c in linker.calls.get(caller, []) if c.callee == callee]
        kind = sites[0].kind if sites else "call"
        calls.append({
            "caller": caller, "callee": callee,
            "line": min((c.line or 0) for c in sites) if sites else 0,
            "weight": weight, "kind": kind,
            "virtual": any(getattr(c, "virtual", False) for c in sites),
        })

    accesses = []
    for pid, accs in interproc.accesses.items():
        for a in accs:
            if a.get("propagated"):
                continue
            accesses.append({
                "proc": pid, "entity": a.get("entity"), "mode": a.get("mode"),
                "line": a.get("line") or 0, "via": a.get("via") or "assign",
                "root": a.get("root"), "root_kind": a.get("root_kind"),
                "scope": a.get("scope"), "type": a.get("type"),
            })

    passes = [{
        "caller": p.get("caller"), "callee": p.get("callee"),
        "line": p.get("line") or 0, "formal": p.get("formal"),
        "actual": p.get("actual"), "mode": p.get("mode") or "read",
    } for p in interproc.passes]

    meta = {}
    for path, m in file_meta.items():
        meta[path] = {**m, "rel_path": m.get("rel_path") or _rel(path, model_root)}

    return {
        "functions": functions,
        "calls": calls,
        "passes": passes,
        "accesses": accesses,
        "types": sym,
        "model_root": model_root,
        "file_meta": meta,
        "profiles": [],
    }


# --------------------------------------------------------------------------- #
# source adapter: sqlite
# --------------------------------------------------------------------------- #

def source_from_sqlite(out_dir: str) -> dict:
    db = os.path.join(out_dir, "dataflow.sqlite")
    if not os.path.isfile(db):
        raise SystemExit(f"error: no dataflow.sqlite in {out_dir}")
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    model_root = ""
    index_path = os.path.join(out_dir, "index.json")
    if os.path.isfile(index_path):
        try:
            with open(index_path, encoding="utf-8") as fh:
                model_root = json.load(fh).get("meta", {}).get("model_root") or ""
        except Exception:
            model_root = ""

    functions: dict[str, dict] = {}
    for row in con.execute("SELECT * FROM functions"):
        functions[row["id"]] = {
            "id": row["id"], "name": row["name"], "module": row["module"],
            "kind": row["kind"], "lang": row["lang"], "file": row["file"],
            "line": row["line"], "end_line": row["end_line"],
            "exec_space": row["exec_space"], "params": [], "result": None,
            "aliases": [],
        }
    for row in con.execute("SELECT * FROM params ORDER BY function_id, coalesce(line, 1e9)"):
        proc = functions.get(row["function_id"])
        if proc is None:
            continue
        proc["params"].append({
            "name": row["name"], "type": row["type"], "rank": row["rank"] or 0,
            "intent": row["intent"], "inferred_intent": row["inferred_intent"] or "none",
            "optional": bool(row["optional"]), "value": bool(row["value"]),
            "pointer": False, "allocatable": False, "target": False,
            "save": False, "by_ref": bool(row["by_ref"]), "const": bool(row["const"]),
            "line": row["line"],
        })

    calls = []
    for row in con.execute("SELECT * FROM calls"):
        calls.append({
            "caller": row["caller"], "callee": row["callee"],
            "line": row["line"] or 0, "weight": 1,
            "kind": row["kind"] or "call", "virtual": bool(row["virtual"]),
        })
    # External stubs are callees only; the functions table does not contain
    # them. Add them so the graph can fold one node per library.
    for row in con.execute("SELECT DISTINCT callee FROM calls WHERE callee LIKE 'ext:%'"):
        ext_id = row["callee"]
        if ext_id in functions:
            continue
        lib = ext_id.split(":", 2)[1] if ext_id.count(":") >= 2 else "external"
        functions[ext_id] = {
            "id": ext_id, "name": ext_id.split(":")[-1], "module": None,
            "kind": "external", "lang": "external", "file": None,
            "line": 0, "end_line": 0, "exec_space": "external",
            "params": [], "result": None, "external": True, "library": lib,
            "aliases": [],
        }

    accesses = []
    for row in con.execute(
            "SELECT function_id, entity, mode, line, via, propagated "
            "FROM accesses WHERE propagated = 0"):
        ent = row["entity"] or ""
        scope = None
        root = None
        root_kind = None
        if ent.startswith("param:"):
            scope = ent.split(":", 1)[1].rsplit("::", 1)[0]
            root = ent.rsplit("::", 1)[-1]
            root_kind = "param"
        elif ent.startswith("var:"):
            scope = ent.split(":", 1)[1].rsplit("::", 1)[0]
            root = ent.rsplit("::", 1)[-1]
            root_kind = "module"
        elif ent.startswith("this:"):
            root_kind = "this"
        accesses.append({
            "proc": row["function_id"], "entity": ent, "mode": row["mode"],
            "line": row["line"] or 0, "via": row["via"] or "assign",
            "root": root, "root_kind": root_kind, "scope": scope, "type": None,
        })

    passes = [{
        "caller": row["caller"], "callee": row["callee"], "line": row["line"] or 0,
        "formal": row["formal"], "actual": row["actual"], "mode": row["mode"],
    } for row in con.execute("SELECT * FROM passes")]

    type_rows = []
    try:
        for row in con.execute("SELECT name, module, extends, fields FROM types"):
            type_rows.append(dict(row))
    except sqlite3.OperationalError:
        type_rows = []
    con.close()

    file_meta = {}
    for pid, proc in functions.items():
        path = proc.get("file")
        if not path:
            continue
        file_meta[path] = {
            "rel_path": _rel(path, model_root), "component": None,
            "is_test": "/test/" in path.replace("\\", "/"), "lang": proc.get("lang"),
        }
    return {
        "functions": functions,
        "calls": calls,
        "passes": passes,
        "accesses": accesses,
        "types": TypesView(type_rows),
        "model_root": model_root,
        "file_meta": file_meta,
        "profiles": [],
    }


# --------------------------------------------------------------------------- #
# graph
# --------------------------------------------------------------------------- #

def _component_of(rel_path: str, meta: dict | None) -> str:
    if meta and meta.get("component"):
        return meta["component"]
    parts = [p for p in (rel_path or "").split("/") if p]
    if not parts:
        return "unknown"
    if parts[0] == "src" and len(parts) > 1:
        return parts[1]
    if parts[0] in ("test", "tests"):
        return "test"
    return parts[0] if len(parts) > 1 else "other"


def _find_root(functions: dict[str, dict], calls: list[dict]) -> str:
    if DEFAULT_ROOT_ID in functions:
        return DEFAULT_ROOT_ID
    incoming = {c["callee"] for c in calls}
    for pid, proc in functions.items():
        if pid.startswith("ext:"):
            continue
        if (proc.get("name") or "").lower() == "icon" and pid not in incoming:
            return pid
    for pid in functions:
        if pid.startswith("ext:"):
            continue
        if pid not in incoming:
            return pid
    return next(iter(functions), "")


def _reachable(root: str, calls: list[dict]) -> tuple[list[str], set[str]]:
    by_caller: dict[str, list[dict]] = defaultdict(list)
    for call in calls:
        by_caller[call["caller"]].append(call)
    for sites in by_caller.values():
        sites.sort(key=lambda c: (c.get("line") or 0, c.get("callee") or ""))
    seen: set[str] = set()
    order: list[str] = []
    stack = [root] if root else []
    while stack:
        node = stack.pop()
        if not node or node in seen:
            continue
        seen.add(node)
        order.append(node)
        # Reverse so the first call site is visited first.
        for site in reversed(by_caller.get(node, [])):
            child = site.get("callee")
            if child and child not in seen:
                stack.append(child)
    return order, seen


def build_graph(functions: dict[str, dict], calls: list[dict], file_meta: dict,
                model_root: str) -> dict:
    root_id = _find_root(functions, calls)
    ordered, reachable = _reachable(root_id, calls)
    # Defensive: if the root is missing, keep all real functions.
    if not ordered:
        ordered = [pid for pid in functions if not pid.startswith("ext:")]
        reachable = set(ordered)

    # Deterministic component/shard tables.
    components: list[str] = []
    comp_index: dict[str, int] = {}
    for pid in ordered:
        proc = functions[pid]
        if pid.startswith("ext:"):
            continue
        rel = (file_meta.get(proc.get("file") or "", {}) or {}).get("rel_path") or _rel(proc.get("file"), model_root)
        comp = _component_of(rel, file_meta.get(proc.get("file") or ""))
        if comp not in comp_index:
            comp_index[comp] = len(components)
            components.append(comp)
    shards = [f"fn/{_safe_name(c)}.json" for c in components]

    folders: list[str] = []
    folder_index: dict[str, int] = {}
    files: list[str] = []
    file_index: dict[str, int] = {}
    libraries: list[str] = []
    library_index: dict[str, int] = {}
    kinds: list[str] = []
    kind_index: dict[str, int] = {}
    execs: list[str] = []
    exec_index: dict[str, int] = {}

    def idx(table: list[str], index: dict[str, int], value: str) -> int:
        if value not in index:
            index[value] = len(table)
            table.append(value)
        return index[value]

    def kind_id(value: str) -> int:
        return idx(kinds, kind_index, value or "unknown")

    def exec_id(value: str) -> int:
        return idx(execs, exec_index, value or "unknown")

    ids: list[str] = []
    names: list[str] = []
    node_rows: list[list] = []
    node_by_id: dict[str, int] = {}

    # Sort real nodes by component/file/line so the string tables are compact
    # and stable; external nodes follow.
    def sort_key(pid: str):
        proc = functions[pid]
        meta = file_meta.get(proc.get("file") or "", {}) or {}
        return (1 if pid.startswith("ext:") else 0,
                meta.get("rel_path") or _rel(proc.get("file"), model_root) or "",
                proc.get("line") or 0, (proc.get("name") or ""), pid)

    for pid in sorted(ordered, key=sort_key):
        proc = functions[pid]
        external = bool(proc.get("external") or pid.startswith("ext:"))
        if external:
            folder = "external"
            library = proc.get("library") or (pid.split(":")[1] if pid.count(":") >= 2 else "external")
            file_name = library
            comp = -1
            shard = -1
            lib = idx(libraries, library_index, library)
            params_count = 0
            reads = writes = 0
            name = proc.get("name") or pid.split(":")[-1]
        else:
            rel = (file_meta.get(proc.get("file") or "", {}) or {}).get("rel_path") or _rel(proc.get("file"), model_root)
            comp_name = _component_of(rel, file_meta.get(proc.get("file") or ""))
            folder = comp_name
            file_name = os.path.basename(rel) or rel
            comp = comp_index.get(comp_name, 0)
            shard = comp
            lib = -1
            params_count = len(proc.get("params") or [])
            reads = proc.get("_read_count", 0)
            writes = proc.get("_write_count", 0)
            name = proc.get("name") or pid.split("::")[-1]
        folder_i = idx(folders, folder_index, folder)
        file_i = idx(files, file_index, file_name)
        flags = 0
        if external:
            flags |= EXT_FLAG
        if (proc.get("lang") == "cpp"):
            flags |= CPP_FLAG
        if proc.get("is_test"):
            flags |= TEST_FLAG
        node_id = len(ids)
        node_by_id[pid] = node_id
        ids.append(pid)
        names.append(name)
        node_rows.append([
            node_id, kind_id("external" if external else (proc.get("kind") or "function")),
            folder_i, file_i, exec_id("external" if external else proc.get("exec_space") or "unknown"),
            flags, params_count, reads, writes, comp, shard, lib,
            proc.get("line") or 0,
        ])

    edges: list[list] = []
    for call in calls:
        a = node_by_id.get(call["caller"])
        b = node_by_id.get(call["callee"])
        if a is None or b is None:
            continue
        edges.append([a, b, int(call.get("weight") or 1),
                      KIND_CODE.get(call.get("kind") or "call", 0),
                      1 if call.get("virtual") else 0])
    # Deduplicate (caller, callee) edges, summing weights.
    merged: dict[tuple, list] = {}
    for e in edges:
        key = (e[0], e[1], e[3], e[4])
        if key in merged:
            merged[key][2] += e[2]
        else:
            merged[key] = list(e)
    edges = list(merged.values())

    return {
        "folders": folders, "files": files, "libraries": libraries,
        "kinds": kinds, "execSpaces": execs, "components": components,
        "fnShards": shards,
        "ids": ids, "names": names, "nodes": node_rows, "edges": edges,
        "root": node_by_id.get(root_id, 0),
        "rootId": root_id,
        "nodeByFunction": node_by_id,
        "reachable": reachable,
        "functionCount": len(ids),
        "externalCount": sum(1 for r in node_rows if r[5] & EXT_FLAG),
    }


# --------------------------------------------------------------------------- #
# trace groups / events
# --------------------------------------------------------------------------- #

@dataclass
class TraceBuild:
    groups: dict[str, dict] = field(default_factory=dict)
    group_of: dict[str, str] = field(default_factory=dict)
    shard_of: dict[str, int] = field(default_factory=dict)
    search: list[list] = field(default_factory=list)
    events_total: int = 0


def _representative(members: list[str]) -> str:
    ranked = sorted(members, key=lambda e: (
        0 if e.startswith("field:") else 1 if e.startswith("param:") else
        2 if e.startswith("var:") else 3 if e.startswith("local:") else 4,
        e))
    return ranked[0] if ranked else "unknown"


def build_traces(source: dict, graph: dict) -> TraceBuild:
    functions = source["functions"]
    accesses = source["accesses"]
    passes = source["passes"]
    calls = source["calls"]
    types = source["types"]
    node_by_fn = graph["nodeByFunction"]
    root = graph.get("rootId")

    uf = UnionFind()
    entity_kind: dict[str, str] = {}

    def canonical(e: str) -> str:
        return canonical_field_entity(e, types)

    def add_entity(e: str) -> str:
        e = canonical(e)
        uf.add(e)
        entity_kind.setdefault(e, _entity_kind(e))
        return e

    # Every parameter becomes an entity even when it is never accessed, so the
    # parameter card can always resolve a group.
    for pid, proc in functions.items():
        if pid.startswith("ext:"):
            continue
        for p in proc.get("params") or []:
            add_entity(f"param:{pid}::{p.get('name')}")

    # Field accesses stay in their leaf-owned field group. Joining every field
    # to its root parameter would merge all components of a derived type (and
    # then every unrelated value passed through that object) into one group.
    # Derived-type parameters therefore have a lightweight group of their own;
    # the field rows in the parameter card remain individually traceable via
    # the data search.
    for acc in accesses:
        if not acc.get("entity"):
            continue
        add_entity(acc.get("entity"))

    # Passes are *directed* edges. Unioning every call site's actual with the
    # callee formal would merge thousands of unrelated values through utility
    # routines (every error-message local passed to `finish` became one group).
    # A formal is joined to its actuals only when they all resolve to the same
    # data entity: `hydro_adjust::rho` receives the same `t_nh_prog%rho` from
    # many callers, so it joins that field; `mpi::finish::text` receives many
    # different locals, so it does not merge them.
    formal_actuals: dict[str, set[str]] = defaultdict(set)
    for p in passes:
        if not p.get("formal") or not p.get("actual"):
            continue
        formal = add_entity(p.get("formal"))
        actual = add_entity(p.get("actual"))
        formal_actuals[formal].add(actual)

    for _ in range(6):
        changed = False
        for formal, actuals in formal_actuals.items():
            roots = {uf.find(a) for a in actuals}
            if len(roots) != 1:
                continue
            root = next(iter(roots))
            if uf.find(formal) != root:
                uf.union(formal, root)
                changed = True
        if not changed:
            break

    # May-aliases from pointer assignment / ASSOCIATE.
    for pid, proc in functions.items():
        for alias in proc.get("aliases") or []:
            left, right = alias.get("left"), alias.get("right")
            if not left or not right:
                continue
            # The alias RHS is generally a member path; the LHS is the local
            # alias name. The linker already resolves accesses through the
            # alias, so this mainly joins the two spellings.
            l = canonical("field:" + left.replace("%", "%") if left.startswith("field:") else "field:" + left)
            r = canonical("field:" + right if not right.startswith("field:") else right)
            # Only add well-formed paths.
            if l.count("%") >= 1 and r.count("%") >= 1:
                uf.union(add_entity(l), add_entity(r))

    raw_groups = uf.groups()
    groups: dict[str, dict] = {}
    group_of: dict[str, str] = {}
    shard_of: dict[str, int] = {}
    member_of_group: dict[str, list[str]] = {}

    for members in raw_groups.values():
        rep = _representative(members)
        gid = _sha1(rep)[:12]
        # Extremely unlikely collision; keep ids unique deterministically.
        if gid in groups and groups[gid]["entity"] != rep:
            gid = _sha1(rep + "|" + ",".join(sorted(members)))[:12]
        shard = int(_sha1(rep)[:2], 16) % TRACE_SHARDS
        groups[gid] = {
            "id": gid,
            "entity": rep,
            "kind": _entity_kind(rep),
            "entities": sorted(members),
            "events": [],
            "backward": {},
            "shard": shard,
        }
        member_of_group[gid] = members
        for m in members:
            group_of[m] = gid
        shard_of[gid] = shard

    # Program order.
    static_order = compute_static_order(root or "", calls, functions)

    def seq(pid: str) -> int:
        return static_order.get(pid, len(static_order) + 1)

    # Per-group entity tables for compact event rows.
    entity_index: dict[str, dict[str, int]] = {}
    for gid, rec in groups.items():
        entity_index[gid] = {m: i for i, m in enumerate(rec["entities"])}

    def event_row(gid: str, fn: str, line: int, role: int, via: str,
                  entity: str, other_fn: str | None = None,
                  other_entity: str | None = None) -> list | None:
        fn_node = node_by_fn.get(fn)
        if fn_node is None:
            return None
        other_node = node_by_fn.get(other_fn) if other_fn else None
        idx = entity_index[gid]
        return [
            fn_node, int(line or 0), role, VIA_INDEX.get(via, VIA_INDEX["assign"]),
            idx.get(entity, -1),
            other_node if other_node is not None else -1,
            idx.get(other_entity, -1) if other_entity else -1,
        ]

    # Direct accesses.
    for acc in accesses:
        pid = acc.get("proc")
        if pid not in node_by_fn:
            continue
        ent = canonical(acc.get("entity") or "")
        gid = group_of.get(ent)
        if not gid:
            continue
        mode = acc.get("mode") or "read"
        via = acc.get("via") or "assign"
        if via == "allocate":
            role = ROLE_CREATE
            if mode in ("read", "readwrite"):
                role |= ROLE_READ
        elif mode == "write":
            role = ROLE_WRITE
        elif mode == "readwrite":
            role = ROLE_WRITE | ROLE_READ
        else:
            role = ROLE_READ
        row = event_row(gid, pid, acc.get("line"), role, via, ent)
        if row:
            groups[gid]["events"].append(row)

    # Passes. `incoming[formal]` is the upstream binding used by backward paths.
    incoming: dict[str, list[dict]] = defaultdict(list)
    for p in passes:
        formal = canonical(p.get("formal") or "")
        actual = canonical(p.get("actual") or "")
        gid = group_of.get(formal) or group_of.get(actual)
        if not gid:
            continue
        caller, callee = p.get("caller"), p.get("callee")
        if caller not in node_by_fn or callee not in node_by_fn:
            continue
        incoming[formal].append({
            "caller": caller, "callee": callee, "line": p.get("line") or 0,
            "formal": formal, "actual": actual, "mode": p.get("mode") or "read",
        })
        row = event_row(gid, caller, p.get("line"), ROLE_PASS, "call",
                        actual, callee, formal)
        if row:
            groups[gid]["events"].append(row)

    # Role refinement: the first direct write to a local/module entity in its
    # owning scope is its creation. Allocate already created its entity.
    by_group_entity: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    for gid, rec in groups.items():
        for i, e in enumerate(rec["events"]):
            if e[2] & ROLE_CREATE:
                continue
            if e[2] & (ROLE_WRITE | ROLE_READ):
                ent = rec["entities"][e[4]] if e[4] >= 0 else ""
                by_group_entity[gid][ent].append(i)
    for gid, entities in by_group_entity.items():
        for ent, indexes in entities.items():
            kind = _entity_kind(ent)
            # Fields that are members of an allocated parent have no explicit
            # allocate record of their own; their first direct write is the
            # point where the data first exists.
            if kind not in ("local", "var", "field"):
                continue
            # A pure write introduces the value; a read-modify-write updates an
            # existing one. Prefer the first pure write as the creation point.
            indexes.sort(key=lambda i: (
                0 if (groups[gid]["events"][i][2] & ROLE_WRITE and
                      not groups[gid]["events"][i][2] & ROLE_READ) else 1,
                seq(_fn_of_row(groups[gid]["events"][i], graph)),
                groups[gid]["events"][i][1]))
            for i in indexes:
                row = groups[gid]["events"][i]
                if row[2] & ROLE_WRITE:
                    row[2] = (row[2] & ROLE_READ) | ROLE_CREATE
                    break

    # Origin + counts + backward paths.
    for gid, rec in groups.items():
        rec["events"].sort(key=lambda e: (seq(graph["ids"][e[0]]) if e[0] < len(graph["ids"]) else 1 << 30, e[1]))
        entities = rec["entities"]
        upstream = set()
        for ent in entities:
            if incoming.get(ent):
                upstream.add(ent)
        origin_candidates = [e for e in entities if e not in upstream] or entities

        create_events = [ev for ev in rec["events"] if ev[2] & ROLE_CREATE]
        origin_candidate_set = set(origin_candidates)
        preferred = [ev for ev in create_events
                     if ev[4] >= 0 and entities[ev[4]] in origin_candidate_set]
        if preferred:
            origin_event = preferred[0]
        elif create_events:
            origin_event = create_events[0]
        elif rec["events"]:
            origin_event = rec["events"][0]
        else:
            origin_event = None

        if origin_event is not None:
            ofn = graph["ids"][origin_event[0]]
            oent = entities[origin_event[4]] if origin_event[4] >= 0 else rec["entity"]
            rec["origin"] = {
                "fn": origin_event[0], "line": origin_event[1],
                "entity": oent, "file": functions.get(ofn, {}).get("file"),
                "name": functions.get(ofn, {}).get("name"),
                "node": origin_event[0],
            }
        else:
            # Searchable group with no accesses (e.g. an unused parameter):
            # point at the function that owns it.
            owner = _owner_function(rec["entity"])
            node = node_by_fn.get(owner)
            rec["origin"] = {
                "fn": node, "line": functions.get(owner, {}).get("line"),
                "entity": rec["entity"], "file": functions.get(owner, {}).get("file"),
                "name": functions.get(owner, {}).get("name"), "node": node,
            }

        roles = {"create": set(), "write": set(), "read": set(), "pass": set()}
        for ev in rec["events"]:
            fn = ev[0]
            if ev[2] & ROLE_CREATE:
                roles["create"].add(fn)
            if ev[2] & ROLE_WRITE:
                roles["write"].add(fn)
            if ev[2] & ROLE_READ:
                roles["read"].add(fn)
            if ev[2] & ROLE_PASS:
                roles["pass"].add(fn)
        rec["counts"] = {
            "create": len(roles["create"]), "write": len(roles["write"]),
            "read": len(roles["read"]), "pass": len(roles["pass"]),
            "functions": len({ev[0] for ev in rec["events"]}),
            "events": len(rec["events"]),
        }

        # Folder/file summary for large full traces.
        folder_counts: dict[str, int] = defaultdict(int)
        file_counts: dict[str, int] = defaultdict(int)
        for fn in {ev[0] for ev in rec["events"]}:
            fn_id = graph["ids"][fn]
            proc = functions.get(fn_id, {})
            rel = (source.get("file_meta", {}).get(proc.get("file") or "", {}) or {}).get("rel_path") or _rel(proc.get("file"), source.get("model_root"))
            comp = _component_of(rel, source.get("file_meta", {}).get(proc.get("file") or ""))
            folder_counts[comp] += 1
            file_counts[os.path.basename(rel) or rel] += 1
        rec["folders"] = sorted(folder_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:40]
        rec["files"] = sorted(file_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:80]

        # Backward pointer chains for every parameter entity in this group.
        for ent in entities:
            if _entity_kind(ent) != "param":
                continue
            chain = _build_backward(ent, incoming, group_of, graph, functions,
                                    static_order, rec)
            if chain:
                rec["backward"][ent] = chain

    # Search index: only fields, parameters and module variables, as planned.
    search_rows: list[list] = []
    seen_keys: set[tuple[str, str]] = set()
    kind_rank = {"field": 0, "param": 1, "var": 2}
    for gid, rec in groups.items():
        members = rec["entities"]
        counts = rec["counts"]
        names: set[str] = set()
        kind = rec["kind"]
        for ent in members:
            ek = _entity_kind(ent)
            if ek not in kind_rank:
                continue
            body = ent.split(":", 1)[1] if ":" in ent else ent
            if ek == "field":
                leaf = body.split("%")[-1]
                names.add(body)
                names.add("%" + leaf)
                names.add(leaf)
            elif ek == "param":
                owner, _, pname = body.rpartition("::")
                names.add(body)
                names.add(pname)
                if owner:
                    names.add(owner.rsplit("::", 1)[-1] + "::" + pname)
            else:
                names.add(body)
                names.add(body.rsplit("::", 1)[-1])
        for name in names:
            key = (name, gid)
            if not name or key in seen_keys:
                continue
            seen_keys.add(key)
            search_rows.append([name, gid, kind_rank.get(kind, 9),
                                counts["read"], counts["write"]])
    search_rows.sort(key=lambda r: (r[0], r[2], -r[3] - r[4], r[1]))

    return TraceBuild(groups=groups, group_of=group_of, shard_of=shard_of,
                      search=search_rows,
                      events_total=sum(len(r["events"]) for r in groups.values()))


def _owner_function(entity: str) -> str | None:
    if entity.startswith("param:") or entity.startswith("local:"):
        return entity.split(":", 1)[1].rsplit("::", 1)[0]
    if entity.startswith("var:"):
        return None
    return None


def _fn_of_row(row: list, graph: dict) -> str:
    fn = row[0]
    return graph["ids"][fn] if 0 <= fn < len(graph["ids"]) else ""


def _backward_file(fn_node: int | None, graph: dict, functions: dict) -> str | None:
    if fn_node is None or not (0 <= fn_node < len(graph["ids"])):
        return None
    return functions.get(graph["ids"][fn_node], {}).get("file")


def _build_backward(param: str, incoming: dict[str, list[dict]], group_of: dict,
                    graph: dict, functions: dict, static_order: dict,
                    group: dict) -> list[list]:
    """Return ``[[fn, line, via, entityIdx, upstreamFn, file], ...]``.

    Step 0 is the parameter owner. Each following step is the caller that
    supplies the previous entity; the last step is the origin function. The
    origin is resolved per path: if the caller writes/creates the actual in the
    function that supplies it, that function is the "start here" point instead
    of the group-wide earliest writer.
    """
    chain: list[list] = []
    seen: set[str] = set()
    cur = param
    owner = _owner_function(param)
    owner_node = graph["nodeByFunction"].get(owner)
    if owner_node is None:
        return []
    rec_entities = group["entities"]
    ent_index = {e: i for i, e in enumerate(rec_entities)}
    chain.append([owner_node, 0, VIA_INDEX["pass"], ent_index.get(param, -1), -1,
                  _backward_file(owner_node, graph, functions)])

    while cur and cur not in seen:
        seen.add(cur)
        ups = incoming.get(cur) or []
        if not ups:
            break
        up = min(ups, key=lambda p: (static_order.get(p["caller"], 1 << 30),
                                     p.get("line") or 0))
        caller_node = graph["nodeByFunction"].get(up["caller"])
        actual = up["actual"]
        if caller_node is None:
            break
        prev = chain[-1]
        prev[1] = up.get("line") or 0
        prev[3] = ent_index.get(cur, prev[3])
        prev[4] = caller_node
        chain.append([caller_node, 0, VIA_INDEX["pass"], ent_index.get(actual, -1), -1,
                      _backward_file(caller_node, graph, functions)])
        cur = actual

    # Did the last caller itself write/create the actual? Then this function is
    # the origin on this path (e.g. copy_initicon2prog_atm for rho).
    last = chain[-1]
    ent_idx = last[3]
    resolved_origin = False
    if ent_idx >= 0:
        candidates = [
            ev for ev in group["events"]
            if ev[0] == last[0] and ev[4] == ent_idx and (ev[2] & (ROLE_CREATE | ROLE_WRITE))
        ]
        if candidates:
            candidates.sort(key=lambda ev: (
                0 if (ev[2] & ROLE_WRITE and not ev[2] & ROLE_READ) else 1,
                ev[1]))
            ev = candidates[0]
            last[1] = ev[1]
            last[2] = ev[2]
            last[4] = -1
            resolved_origin = True

    # Otherwise append the group origin when it is a different function.
    origin = group.get("origin") or {}
    origin_node = origin.get("node")
    if not resolved_origin and origin_node is not None and chain[-1][0] != origin_node:
        chain.append([origin_node, origin.get("line") or 0, VIA_INDEX["pass"],
                      ent_index.get(origin.get("entity"), -1), -1,
                      _backward_file(origin_node, graph, functions)])
    # Collapse immediate duplicates.
    out = []
    for step in chain:
        if out and out[-1][0] == step[0]:
            out[-1] = step
        else:
            out.append(step)
    return out


# --------------------------------------------------------------------------- #
# function parameter shards
# --------------------------------------------------------------------------- #

def build_function_shards(source: dict, graph: dict, trace: TraceBuild,
                          vis_dir: str) -> dict:
    functions = source["functions"]
    node_by_fn = graph["nodeByFunction"]
    file_meta = source.get("file_meta", {})
    model_root = source.get("model_root") or ""
    components = graph["components"]
    shards = graph["fnShards"]
    comp_index = {c: i for i, c in enumerate(components)}
    payloads: list[dict] = [dict() for _ in shards]

    for pid, node in node_by_fn.items():
        proc = functions.get(pid)
        row = graph["nodes"][node]
        if not proc or (row[5] & EXT_FLAG):
            continue
        comp = components[row[9]] if 0 <= row[9] < len(components) else "unknown"
        shard = comp_index.get(comp)
        if shard is None:
            continue
        meta = file_meta.get(proc.get("file") or "", {}) or {}
        rel = meta.get("rel_path") or _rel(proc.get("file"), model_root)
        params = []
        for p in proc.get("params") or []:
            pname = p.get("name")
            entity = canonical_field_entity(f"param:{pid}::{pname}", source["types"])
            gid = trace.group_of.get(entity)
            flags = 0
            for flag, key in ((1, "optional"), (2, "pointer"), (4, "allocatable"),
                              (8, "target"), (16, "value"), (32, "save"),
                              (64, "by_ref"), (128, "const")):
                if p.get(key):
                    flags |= flag
            params.append({
                "n": pname,
                "t": p.get("type"),
                "r": p.get("rank") or 0,
                "i": _norm_intent(p.get("intent")),
                "ii": _norm_intent(p.get("inferred_intent")),
                "f": flags,
                "g": gid,
                "l": p.get("line"),
            })
        payloads[shard][pid] = {
            "id": pid,
            "name": proc.get("name"),
            "module": proc.get("module"),
            "kind": proc.get("kind"),
            "file": rel,
            "abs": proc.get("file"),
            "line": proc.get("line"),
            "endLine": proc.get("end_line"),
            "exec": proc.get("exec_space") or "unknown",
            "params": params,
            "result": proc.get("result"),
        }

    info = {}
    for i, shard in enumerate(shards):
        path = os.path.join(vis_dir, shard)
        info[shard] = _write_json(path, {"functions": payloads[i]})
    return {"shards": len(shards), "functions": sum(len(p) for p in payloads),
            "files": info}


# --------------------------------------------------------------------------- #
# trace shards + search
# --------------------------------------------------------------------------- #

def build_trace_shards(trace: TraceBuild, vis_dir: str) -> dict:
    shards: list[dict] = [dict() for _ in range(TRACE_SHARDS)]
    for gid, rec in trace.groups.items():
        shard = trace.shard_of.get(gid, 0)
        payload = {
            "id": gid,
            "entity": rec["entity"],
            "kind": rec["kind"],
            "entities": rec["entities"],
            "events": rec["events"],
            "backward": rec["backward"],
            "origin": rec["origin"],
            "counts": rec["counts"],
            "folders": rec["folders"],
            "files": rec["files"],
            "vias": VIA_NAMES,
        }
        shards[shard][gid] = payload
    written = 0
    size = 0
    for i, groups in enumerate(shards):
        if not groups:
            continue
        path = os.path.join(vis_dir, "trace", f"{i:02x}.json")
        sizes = _write_json(path, {"groups": groups, "vias": VIA_NAMES})
        written += 1
        size += sizes.get("br", sizes["raw"])
    return {"shards": written, "compressed_bytes": size}


def build_search_index(trace: TraceBuild, vis_dir: str) -> dict:
    rows = trace.search
    payload = {
        "names": [r[0] for r in rows],
        "groups": [r[1] for r in rows],
        "kinds": [r[2] for r in rows],
        "reads": [r[3] for r in rows],
        "writes": [r[4] for r in rows],
    }
    sizes = _write_json(os.path.join(vis_dir, "search.json"), payload)
    return {"entries": len(rows), **sizes}


# --------------------------------------------------------------------------- #
# public build
# --------------------------------------------------------------------------- #

def build(source: dict, vis_dir: str, graph_only: bool = False) -> dict:
    functions = source["functions"]
    calls = source["calls"]
    accesses = source["accesses"]
    file_meta = source.get("file_meta", {})

    # Direct read/write counts for the graph node tuples.
    reads: dict[str, set] = defaultdict(set)
    writes: dict[str, set] = defaultdict(set)
    for acc in accesses:
        ent = acc.get("entity") or ""
        if acc.get("mode") in ("read", "readwrite"):
            reads[acc.get("proc")].add(ent)
        if acc.get("mode") in ("write", "readwrite"):
            writes[acc.get("proc")].add(ent)
    for pid, proc in functions.items():
        proc["_read_count"] = len(reads.get(pid, ()))
        proc["_write_count"] = len(writes.get(pid, ()))

    graph = build_graph(functions, calls, file_meta, source.get("model_root") or "")
    if not graph["ids"]:
        raise SystemExit("error: no reachable functions; cannot build graph.json")

    os.makedirs(vis_dir, exist_ok=True)
    # Remove stale shards from a previous run so deleted components do not
    # leave orphaned files behind.
    for sub in ("fn", "trace"):
        path = os.path.join(vis_dir, sub)
        if os.path.isdir(path):
            shutil.rmtree(path)
    graph_payload = {
        "version": 1,
        "root": graph["root"],
        "rootId": graph["rootId"],
        "folders": graph["folders"],
        "files": graph["files"],
        "libraries": graph["libraries"],
        "kinds": graph["kinds"],
        "execSpaces": graph["execSpaces"],
        "components": graph["components"],
        "fnShards": graph["fnShards"],
        "ids": graph["ids"],
        "names": graph["names"],
        "nodes": graph["nodes"],
        # Flat [from, to, weight, kind, virtual, ...] array as planned.
        "edges": [value for edge in graph["edges"] for value in edge],
        "counts": {
            "nodes": graph["functionCount"],
            "external": graph["externalCount"],
            "edges": len(graph["edges"]),
        },
    }
    sizes = {"graph.json": _write_json(os.path.join(vis_dir, "graph.json"), graph_payload)}
    result = {
        "graph": graph_payload["counts"],
        "graph.json": sizes["graph.json"],
    }
    if graph_only:
        result["vis_dir"] = vis_dir
        return result

    trace = build_traces(source, graph)
    result["traces"] = {
        "groups": len(trace.groups),
        "events": trace.events_total,
        **build_trace_shards(trace, vis_dir),
    }
    result["functions"] = build_function_shards(source, graph, trace, vis_dir)
    result["search"] = build_search_index(trace, vis_dir)
    result["vis_dir"] = vis_dir
    return result


def run_layout(graph_path: str, layout_path: str, script: str | None = None) -> bool:
    script = script or os.path.join(os.getcwd(), "build_layout.js")
    if not os.path.isfile(script):
        return False
    node = shutil.which("node")
    if not node:
        return False
    proc = subprocess.run([node, script, graph_path, layout_path],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        print(proc.stderr.decode("utf-8", "replace")[:2000], file=sys.stderr)
        return False
    compress_file(layout_path)
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export the static call-graph viewer data.")
    ap.add_argument("--out", default="data_extraction/out",
                    help="extraction output directory (contains dataflow.sqlite)")
    ap.add_argument("--vis", default="vis", help="viewer output directory")
    ap.add_argument("--graph-only", action="store_true")
    ap.add_argument("--no-layout", action="store_true",
                    help="skip build_layout.js even when Node is available")
    ap.add_argument("--layout-script", default=None)
    args = ap.parse_args(argv)

    source = source_from_sqlite(os.path.abspath(args.out))
    vis_dir = os.path.abspath(args.vis)
    res = build(source, vis_dir, graph_only=args.graph_only)
    print(json.dumps(res.get("graph"), indent=0))
    print(f"wrote {res['graph.json']['raw'] / 1e6:.1f} MB graph.json -> {vis_dir}")
    if not args.graph_only:
        print(f"traces: {res['traces']}")
        print(f"functions: {res['functions']['functions']} in {res['functions']['shards']} shards")
        print(f"search: {res['search']['entries']} entries, "
              f"{res['search'].get('br', res['search']['raw']) / 1e6:.1f} MB compressed")
        if not args.no_layout:
            graph_path = os.path.join(vis_dir, "graph.json")
            layout_path = os.path.join(vis_dir, "layout.json")
            if run_layout(graph_path, layout_path, args.layout_script):
                print(f"wrote {layout_path}")
            else:
                print("warning: layout.json not written (Node/build_layout.js unavailable)",
                      file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
