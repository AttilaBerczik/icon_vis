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
    # Component names can be "." or ".." (functions whose source lives outside
    # the model root). Kept verbatim they produce shard paths like
    # ``fn/...json``, which static servers and IDE dev servers reject as a path
    # traversal attempt, so shard names never contain a dot.
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", text or "").strip("_")
    return name or "unknown"


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
                "file": row.get("file"),
                "line": row.get("line"),
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


INTRINSIC_TYPES = {
    "integer", "real", "logical", "character", "complex", "double",
    "doubleprecision", "byte", "int", "long", "short", "float", "bool",
    "void", "c_ptr", "c_funptr", "c_int", "c_double", "c_float", "c_char",
    "c_bool", "c_size_t", "c_int64_t", "c_int32_t", "c_loc",
}
MAX_VALUE_FIELDS = 4
MAX_TYPE_WALK = 64


def _base_type_name(value) -> str | None:
    """Return the bare type name of a declaration type spelling.

    ``real(kind=wp)`` -> ``real``; ``type(t_patch)`` -> ``t_patch``;
    ``class(foo)`` -> ``foo``. Module qualification (``module::type``) is
    dropped because field entities carry the bare name.
    """
    text = (value or "").strip()
    if not text:
        return None
    low = text.lower()
    if low.startswith(("type(", "class(")):
        text = text[text.find("(") + 1:]
        if text.endswith(")"):
            text = text[:-1]
    text = text.split("(")[0].strip()
    return text.split("::")[-1].lower() or None


def _is_intrinsic_type(value) -> bool:
    base = _base_type_name(value)
    return bool(base) and base in INTRINSIC_TYPES


_DECL_LINE_CACHE: dict[tuple[str, str], int | None] = {}
_COMPONENT_LINE_CACHE: dict[tuple[str, str, str], int | None] = {}
_FILE_LINES_CACHE: dict[str, list[str]] = {}


def _fortran_path(path: str | None) -> bool:
    ext = os.path.splitext((path or "").lower())[1]
    return ext in {".f90", ".f", ".f03", ".f08", ".f77", ".fpp", ".for", ".ftn"}


def _file_lines(path: str | None) -> list[str]:
    if not path:
        return []
    if path in _FILE_LINES_CACHE:
        return _FILE_LINES_CACHE[path]
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        lines = []
    _FILE_LINES_CACHE[path] = lines
    return lines


def _find_type_declaration_line(path: str | None, name: str) -> int | None:
    """Best-effort ``TYPE ... :: name`` line from the original source.

    The parser does not expose a span for every ``Derived_Type_Def`` (and the
    cached facts may predate that fix), so this scans the source once per
    ``(path, type)`` pair. C++ sources are left to the parser's own line.
    """
    if not path or not name or not _fortran_path(path):
        return None
    key = (path, name)
    if key in _DECL_LINE_CACHE:
        return _DECL_LINE_CACHE[key]
    result = None
    for number, line in enumerate(_file_lines(path), 1):
        text = line.split("!", 1)[0]
        if not re.match(r"\s*type\b", text, re.I):
            continue
        if re.match(r"\s*type\s*\(", text, re.I):
            continue
        if re.search(r"\b" + re.escape(name) + r"\b", text, re.I):
            result = number
            break
    _DECL_LINE_CACHE[key] = result
    return result


def _find_component_line(path: str | None, type_name: str,
                         field_name: str, fallback=None) -> int | None:
    """Line of one component inside its type block.

    A single declaration can span dozens of continuation lines
    (``REAL :: & ... & t2m_bias``), and fparser reports the start of the whole
    statement for every component. Scanning the type block finds the actual
    component line without changing the parser/cache.
    """
    if not path or not type_name or not field_name or not _fortran_path(path):
        return fallback
    key = (path, type_name, field_name)
    if key in _COMPONENT_LINE_CACHE:
        cached = _COMPONENT_LINE_CACHE[key]
        return cached if cached is not None else fallback
    lines = _file_lines(path)
    start = _find_type_declaration_line(path, type_name)
    result = None
    if start:
        end = len(lines)
        for number in range(start, len(lines)):
            if re.match(r"\s*end\s*type\b", lines[number], re.I):
                end = number + 1
                break
        pattern = re.compile(r"\b" + re.escape(field_name) + r"\b", re.I)
        for number in range(start, end):
            text = lines[number].split("!", 1)[0]
            if pattern.search(text):
                result = number + 1
                break
    _COMPONENT_LINE_CACHE[key] = result
    return result if result is not None else fallback


@dataclass
class FieldResolution:
    """Result of walking a typed field path through the type table."""

    member: str | None          # ``declaring_type%member`` (merge identity)
    route: str                  # full typed path as spelled by the entity
    owner_chain: list[str]      # declaring type per walked step
    subcomponent: str | None    # value-type tail (``x`` or ``x%y``)
    unresolved: bool = False

    @property
    def declaring_type(self) -> str | None:
        return self.member.split("%", 1)[0] if self.member else None


class TypeRegistry:
    """Type lookup with declaration metadata, inheritance and value types.

    Field entities only carry the bare type name (``field:t_patch%cells%x``),
    so the registry keys types by that name. ``module`` and ``file`` are kept
    as metadata on the type page. Duplicate names across modules resolve to the
    first declaration, matching the extractor's field spelling.
    """

    def __init__(self, types):
        self.records: dict[str, dict] = {}
        self.by_name: dict[str, list[dict]] = defaultdict(list)
        raw = getattr(types, "types", types) or {}
        if isinstance(raw, dict):
            entries = []
            for name, lst in raw.items():
                for t in lst or []:
                    entries.append((name, t))
        else:
            entries = [((t or {}).get("name"), t) for t in raw]
        for fallback_name, t in entries:
            if not t:
                continue
            name = (t.get("name") or fallback_name or "").lower()
            if not name:
                continue
            file = t.get("file") or t.get("rel_path") or ""
            line = _find_type_declaration_line(file, name)
            if not line:
                line = t.get("line")
            if not line:
                field_lines = [fx.get("line") for fx in t.get("fields") or []
                               if fx.get("line")]
                if field_lines:
                    line = min(field_lines)
            rec = {
                "name": name,
                "module": (t.get("module") or None),
                "extends": _base_type_name(t.get("extends")),
                "file": file,
                "line": line,
                "fields": list(t.get("fields") or []),
                "raw": t,
            }
            self.by_name[name].append(rec)
            self.records.setdefault(name, rec)
        # A handful of type names exist in more than one module. Field
        # entities only carry the bare name, so resolution sees the union of
        # their components. This resolves e.g. `t_var%info` even though the
        # first `t_var` declaration (mo_meteogram_output) has no such field.
        for name, variants in list(self.by_name.items()):
            if len(variants) < 2:
                continue
            canonical = max(
                variants,
                key=lambda r: (len(r.get("fields") or []), r.get("file") or "",
                               r.get("line") or 0),
            )
            merged: list[dict] = []
            seen_fields: set[str] = set()
            for rec in [canonical] + sorted(
                    (v for v in variants if v is not canonical),
                    key=lambda r: (-len(r.get("fields") or []), r.get("file") or "")):
                for field in rec.get("fields") or []:
                    fname = (field.get("name") or "").lower()
                    if not fname or fname in seen_fields:
                        continue
                    seen_fields.add(fname)
                    merged.append(field)
            self.records[name] = {
                **canonical,
                "fields": merged,
                "variants": [
                    {"module": v.get("module"), "file": v.get("file"),
                     "line": v.get("line"), "fields": len(v.get("fields") or [])}
                    for v in variants
                ],
            }
            self.by_name[name] = [self.records[name]]
        self._value_cache: dict[str, bool] = {}
        self._field_cache: dict[tuple[str, str], tuple[str, dict] | None] = {}
        self._children: dict[str, list[str]] = defaultdict(list)
        for child_name, child_rec in self.records.items():
            parent = child_rec.get("extends")
            if parent:
                self._children[parent].append(child_name)

    # -- basic lookup -------------------------------------------------------
    def get(self, name: str | None) -> dict | None:
        return self.records.get((name or "").lower())

    def key(self, name: str | None) -> str:
        return (name or "").lower()

    def chain(self, name: str | None, module: str | None = None) -> list[dict]:
        chain: list[dict] = []
        seen: set[str] = set()
        cur = (name or "").lower()
        while cur and cur not in seen:
            seen.add(cur)
            rec = None
            if module and not chain:
                for cand in self.by_name.get(cur, []):
                    if (cand.get("module") or "") == module:
                        rec = cand
                        break
            rec = rec or self.get(cur)
            if not rec:
                break
            chain.append(rec)
            cur = rec.get("extends") or ""
        return chain

    def descendants(self, name: str) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        stack = list(self._children.get((name or "").lower(), []))
        while stack:
            child = stack.pop()
            if child in seen:
                continue
            seen.add(child)
            out.append(child)
            stack.extend(self._children.get(child, []))
        return out

    def find_field(self, owner: str, component: str) -> tuple[str, dict] | None:
        cache_key = ((owner or "").lower(), (component or "").lower())
        if cache_key in self._field_cache:
            return self._field_cache[cache_key]
        result = None
        comp = (component or "").lower()
        for t in self.chain(owner):
            for f in t.get("fields") or []:
                if (f.get("name") or "").lower() == comp:
                    result = (t["name"], f)
                    break
            if result:
                break
        if result is None:
            # Polymorphic CLASS(T) access: the declared type is an abstract
            # base, while the component is declared by a subtype. Resolve only
            # when exactly one subtype declares the component; otherwise the
            # dynamic type is unknown and the path stays unresolved.
            candidates = []
            for child in self.descendants(owner):
                rec = self.get(child) or {}
                for f in rec.get("fields") or []:
                    if (f.get("name") or "").lower() == comp:
                        candidates.append((rec["name"], f))
                        break
            declaring = {c[0] for c in candidates}
            if len(declaring) == 1:
                result = candidates[0]
        self._field_cache[cache_key] = result
        return result

    def fields_with_owner(self, name: str) -> list[dict]:
        """Direct fields followed by inherited fields (nearest base first)."""
        out: list[dict] = []
        seen: set[str] = set()
        for rec in self.chain(name):
            inherited = rec["name"] != (name or "").lower()
            for f in rec.get("fields") or []:
                fname = (f.get("name") or "").lower()
                if not fname or fname in seen:
                    continue
                seen.add(fname)
                out.append({
                    **f,
                    "name": fname,
                    "declaring": rec["name"],
                    "inheritedFrom": rec["name"] if inherited else None,
                })
        return out

    # -- value types --------------------------------------------------------
    def is_value(self, name: str | None) -> bool:
        key = (name or "").lower()
        if not key:
            return False
        if key in self._value_cache:
            return self._value_cache[key]
        # Guard against recursive EXTENDS chains.
        self._value_cache[key] = False
        rec = self.get(key)
        value = False
        if rec is not None and not rec.get("extends"):
            fields = rec.get("fields") or []
            value = 0 < len(fields) <= MAX_VALUE_FIELDS
            if value:
                for f in fields:
                    if f.get("pointer") or f.get("allocatable"):
                        value = False
                        break
                    if not _is_intrinsic_type(f.get("type")):
                        value = False
                        break
        self._value_cache[key] = value
        return value

    # -- path resolution ----------------------------------------------------
    def resolve(self, entity: str) -> FieldResolution | None:
        if not entity or not entity.startswith("field:"):
            return None
        path = entity.split(":", 1)[1]
        parts = [p for p in path.split("%") if p]
        if len(parts) < 2:
            return FieldResolution(None, path, [], None, unresolved=True)
        root = parts[0].lower()
        if self.get(root) is None:
            return FieldResolution(None, path, [], None, unresolved=True)
        owner = root
        chain: list[str] = []
        steps = 0
        i = 1
        while i < len(parts):
            steps += 1
            if steps > MAX_TYPE_WALK:
                return FieldResolution(None, path, chain, None, unresolved=True)
            comp = parts[i].lower()
            found = self.find_field(owner, comp)
            if found is None:
                return FieldResolution(None, path, chain, None, unresolved=True)
            declaring, field_info = found
            chain.append(declaring)
            member = declaring + "%" + comp
            if i == len(parts) - 1:
                return FieldResolution(member, path, chain, None)
            next_type = _base_type_name(field_info.get("type"))
            if not next_type or self.get(next_type) is None:
                # The rest of the route is not modelled: keep it unresolved
                # instead of silently folding it.
                return FieldResolution(None, path, chain, None, unresolved=True)
            if self.is_value(next_type):
                sub = "%".join(parts[i + 1:])
                return FieldResolution(member, path, chain, sub or None)
            owner = next_type
            i += 1
        return FieldResolution(None, path, chain, None, unresolved=True)


def canonical_field_entity(entity: str, types) -> str:
    """Merge equivalent field paths onto the type that declares the leaf.

    ``field:t_nh_state%prog%rho`` -> ``field:t_nh_prog%rho`` because ``rho``
    is declared by ``t_nh_prog``. Value-type tails are folded into their
    parent member. Paths that cannot be resolved are returned unchanged
    (never guessed).
    """
    registry = types if isinstance(types, TypeRegistry) else TypeRegistry(types)
    res = registry.resolve(entity)
    if res and res.member:
        return "field:" + res.member
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

def _decl_flags(decl: dict) -> int:
    flags = 0
    for flag, key in ((1, "optional"), (2, "pointer"), (4, "allocatable"),
                      (8, "target"), (16, "value"), (32, "save"),
                      (64, "by_ref"), (128, "const")):
        if decl.get(key):
            flags |= flag
    return flags


def collect_variables(sym) -> list[dict]:
    """Every declared holder: module variables, dummy arguments and locals."""
    out: list[dict] = []
    module_file = {name: (mod or {}).get("file")
                   for name, mod in getattr(sym, "modules", {}).items()}
    for module, variables in getattr(sym, "module_vars", {}).items():
        file = module_file.get(module)
        for name, decl in variables.items():
            out.append({
                "id": f"var:{module}::{name}",
                "kind": "var", "name": name, "scope": module, "module": module,
                "type": decl.get("type"), "rank": decl.get("rank") or 0,
                "line": decl.get("line"), "file": file,
                "flags": _decl_flags(decl),
            })
    for pid, proc in getattr(sym, "procs", {}).items():
        file = proc.get("file")
        module = proc.get("module")
        params = proc.get("params") or []
        param_names = {d.get("name") for d in params}
        for decl in params:
            out.append({
                "id": f"param:{pid}::{decl.get('name')}",
                "kind": "param", "name": decl.get("name"), "scope": pid,
                "module": module, "type": decl.get("type"),
                "rank": decl.get("rank") or 0, "line": decl.get("line"),
                "file": file, "flags": _decl_flags(decl),
            })
        for decl in proc.get("decls") or []:
            # The frontends keep dummy arguments in `decls` as well. They are
            # already listed as parameters above; emitting a second `local:`
            # holder makes the explorer label an argument as a local.
            if decl.get("name") in param_names:
                continue
            out.append({
                "id": f"local:{pid}::{decl.get('name')}",
                "kind": "local", "name": decl.get("name"), "scope": pid,
                "module": module, "type": decl.get("type"),
                "rank": decl.get("rank") or 0, "line": decl.get("line"),
                "file": file, "flags": _decl_flags(decl),
            })
    return out


def _entity_types_from_accesses(accesses: list[dict]) -> dict[str, str]:
    out: dict[str, str] = {}
    for acc in accesses:
        entity = acc.get("entity") or ""
        decl_type = _base_type_name(acc.get("type"))
        if entity and decl_type and not entity.startswith("field:"):
            out.setdefault(entity, decl_type)
    return out


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

    variables = collect_variables(sym)
    return {
        "functions": functions,
        "calls": calls,
        "passes": passes,
        "accesses": accesses,
        "types": sym,
        "variables": variables,
        "entity_types": _entity_types_from_accesses(accesses),
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
        for row in con.execute(
                "SELECT name, module, extends, file, line, fields FROM types"):
            type_rows.append(dict(row))
    except sqlite3.OperationalError:
        try:
            for row in con.execute("SELECT name, module, extends, fields FROM types"):
                type_rows.append(dict(row))
        except sqlite3.OperationalError:
            type_rows = []

    variables: list[dict] = []
    try:
        for row in con.execute(
                "SELECT id, kind, name, scope, module, type, rank, line, file, flags "
                "FROM variables"):
            variables.append(dict(row))
    except sqlite3.OperationalError:
        variables = []

    entity_types: dict[str, str] = {}
    entities_meta = {}
    try:
        for row in con.execute("SELECT id, kind, type FROM entities"):
            decl_type = _base_type_name(row["type"])
            if decl_type and row["kind"] in ("param", "var", "local"):
                entity_types.setdefault(row["id"], decl_type)
            entities_meta[row["id"]] = {"kind": row["kind"]}
    except sqlite3.OperationalError:
        entities_meta = {}
    con.close()

    if not variables:
        # Older databases have no variables table: reconstruct what the
        # parameter and entity tables know about holders.
        seen_ids = set()
        for pid, proc in functions.items():
            for p in proc.get("params") or []:
                vid = f"param:{pid}::{p.get('name')}"
                seen_ids.add(vid)
                variables.append({
                    "id": vid, "kind": "param", "name": p.get("name"),
                    "scope": pid, "module": proc.get("module"),
                    "type": p.get("type"), "rank": p.get("rank") or 0,
                    "line": p.get("line"), "file": proc.get("file"),
                    "flags": _decl_flags(p),
                })
        for vid, meta in entities_meta.items():
            if vid in seen_ids or meta.get("kind") not in ("var", "local"):
                continue
            decl_type = entity_types.get(vid)
            body = vid.split(":", 1)[1] if ":" in vid else vid
            scope, _, name = body.rpartition("::")
            variables.append({
                "id": vid, "kind": meta.get("kind"), "name": name,
                "scope": scope, "module": None, "type": decl_type,
                "rank": 0, "line": None, "file": None, "flags": 0,
            })

    file_meta = {}
    for pid, proc in functions.items():
        path = proc.get("file")
        if not path:
            continue
        file_meta[path] = {
            "rel_path": _rel(path, model_root), "component": None,
            "is_test": "/test/" in path.replace("\\", "/"), "lang": proc.get("lang"),
        }
    if not entity_types:
        entity_types = _entity_types_from_accesses(accesses)
    return {
        "functions": functions,
        "calls": calls,
        "passes": passes,
        "accesses": accesses,
        "types": TypesView(type_rows),
        "variables": variables,
        "entity_types": entity_types,
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
    shards: list[str] = []
    used_shard_names: set[str] = set()
    for component in components:
        base = _safe_name(component)
        candidate = base
        suffix = 2
        while candidate in used_shard_names:
            candidate = f"{base}-{suffix}"
            suffix += 1
        used_shard_names.add(candidate)
        shards.append(f"fn/{candidate}.json")

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
    member_routes: dict[str, list] = field(default_factory=dict)
    member_gid: dict[str, str] = field(default_factory=dict)
    type_totals: dict[str, dict] = field(default_factory=dict)
    registry: TypeRegistry | None = None


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
    registry = types if isinstance(types, TypeRegistry) else TypeRegistry(types)
    node_by_fn = graph["nodeByFunction"]
    root = graph.get("rootId")

    uf = UnionFind()
    entity_kind: dict[str, str] = {}
    field_res: dict[str, FieldResolution] = {}
    preferred: dict[str, str] = {}

    # Declared type of every holder (param / var / local).
    entity_types: dict[str, str] = dict(source.get("entity_types") or {})
    for pid, proc in functions.items():
        for p in proc.get("params") or []:
            decl_type = _base_type_name(p.get("type"))
            if decl_type:
                entity_types.setdefault(f"param:{pid}::{p.get('name')}", decl_type)
    for var in source.get("variables") or []:
        decl_type = _base_type_name(var.get("type"))
        if decl_type and var.get("id"):
            entity_types.setdefault(var["id"], decl_type)

    def decl_type(entity: str) -> str | None:
        if not entity:
            return None
        if entity.startswith("field:"):
            res = field_res.get(entity)
            if not res or not res.member:
                return None
            declaring, _, member = res.member.partition("%")
            found = registry.find_field(declaring, member)
            return _base_type_name(found[1].get("type")) if found else None
        return entity_types.get(entity)

    def is_struct_type(name: str | None) -> bool:
        return bool(name) and registry.get(name) is not None and not registry.is_value(name)

    def add_entity(e: str) -> str:
        uf.add(e)
        entity_kind.setdefault(e, _entity_kind(e))
        return e

    def add_field(e: str) -> str:
        """Add a field entity plus its route and return the member identity."""
        res = registry.resolve(e)
        if res is None:
            return add_entity(e)
        route_entity = "field:" + res.route
        if res.member:
            member_entity = "field:" + res.member
            preferred.setdefault(member_entity, member_entity)
        else:
            member_entity = e
        field_res[e] = res
        field_res[member_entity] = res
        field_res[route_entity] = res
        add_entity(member_entity)
        add_entity(route_entity)
        uf.union(member_entity, route_entity)
        return member_entity

    def canonical(e: str) -> str:
        if e and e.startswith("field:"):
            return add_field(e)
        return add_entity(e)

    def event_entity(e: str) -> str:
        if e and e.startswith("field:"):
            res = field_res.get(e) or registry.resolve(e)
            if res and res.route:
                return "field:" + res.route
        return e

    # Every parameter becomes an entity even when it is never accessed, so the
    # parameter card can always resolve a group.
    for pid, proc in functions.items():
        if pid.startswith("ext:"):
            continue
        for p in proc.get("params") or []:
            add_entity(f"param:{pid}::{p.get('name')}")

    # Field accesses are merged onto the type that declares the leaf. Every
    # raw route stays in the group so the explorer can filter by route.
    for acc in accesses:
        entity = acc.get("entity")
        if entity:
            canonical(entity)

    # Passes are *directed* edges. A struct-typed formal is only joined to
    # actuals of the same declared type; field actuals feed the member group,
    # never the formal. Other formals keep the old "all actuals agree" rule.
    formal_actuals: dict[str, set[str]] = defaultdict(set)
    for p in passes:
        if not p.get("formal") or not p.get("actual"):
            continue
        formal = add_entity(p.get("formal"))
        actual = canonical(p.get("actual"))
        ftype = decl_type(formal)
        if is_struct_type(ftype):
            atype = decl_type(actual)
            if str(actual).startswith("field:") or not atype or atype != ftype:
                continue
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
            l = "field:" + left if not left.startswith("field:") else left
            r = "field:" + right if not right.startswith("field:") else right
            if l.count("%") >= 2 and r.count("%") >= 2:
                uf.union(canonical(l), canonical(r))

    raw_groups = uf.groups()
    groups: dict[str, dict] = {}
    group_of: dict[str, str] = {}
    shard_of: dict[str, int] = {}
    member_gid: dict[str, str] = {}

    for members in raw_groups.values():
        member_path = None
        for m in members:
            res = field_res.get(m)
            if res and res.member:
                member_path = res.member
                break
        rep = preferred.get(next((m for m in members if m in preferred), ""), None)
        if rep is None:
            rep = _representative(members)
        gid = _sha1(rep)[:12]
        # Extremely unlikely collision; keep ids unique deterministically.
        if gid in groups and groups[gid]["entity"] != rep:
            gid = _sha1(rep + "|" + ",".join(sorted(members)))[:12]
        shard = int(_sha1(rep)[:2], 16) % TRACE_SHARDS
        unresolved = bool(member_path is None and any(
            _entity_kind(m) == "field" and not (field_res.get(m) and field_res[m].member)
            for m in members))
        groups[gid] = {
            "id": gid,
            "entity": rep,
            "kind": _entity_kind(rep),
            "entities": sorted(members),
            "events": [],
            "backward": {},
            "routes": [],
            "member": member_path,
            "declaringType": member_path.split("%", 1)[0] if member_path else None,
            "unresolved": unresolved,
            "shard": shard,
        }
        if member_path:
            member_gid[member_path] = gid
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
        raw = acc.get("entity") or ""
        ent = canonical(raw)
        gid = group_of.get(ent)
        if not gid:
            continue
        route = event_entity(raw)
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
        row = event_row(gid, pid, acc.get("line"), role, via, route)
        if row:
            groups[gid]["events"].append(row)

    # Passes. `incoming[formal]` is the upstream binding used by backward paths.
    incoming: dict[str, list[dict]] = defaultdict(list)
    for p in passes:
        formal_raw = p.get("formal") or ""
        actual_raw = p.get("actual") or ""
        formal = canonical(formal_raw)
        actual = canonical(actual_raw)
        # A field actual belongs to the member group; the formal keeps its own
        # group and receives a directed pass edge instead of a union.
        if actual_raw.startswith("field:"):
            gid = group_of.get(actual) or group_of.get(formal)
            event_actual = event_entity(actual_raw)
        else:
            gid = group_of.get(formal) or group_of.get(actual)
            event_actual = event_entity(actual_raw)
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
                        event_actual, callee, formal)
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
            if kind not in ("local", "var", "field"):
                continue
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

    # Origin + route provenance + counts + backward paths.
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
        preferred_events = [ev for ev in create_events
                            if ev[4] >= 0 and entities[ev[4]] in origin_candidate_set]
        if preferred_events:
            origin_event = preferred_events[0]
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
            owner = _owner_function(rec["entity"])
            node = node_by_fn.get(owner)
            line = functions.get(owner, {}).get("line")
            if rec["entity"].startswith("param:"):
                pname = rec["entity"].rsplit("::", 1)[-1]
                for proc_param in functions.get(owner, {}).get("params") or []:
                    if proc_param.get("name") == pname and proc_param.get("line"):
                        line = proc_param.get("line")
                        break
            rec["origin"] = {
                "fn": node, "line": line,
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

        # Route summary: [route, reads, writes, creates, functionCount].
        route_stats: dict[str, dict] = {}
        for ev in rec["events"]:
            if ev[4] < 0:
                continue
            ent = entities[ev[4]]
            if not ent.startswith("field:"):
                continue
            route = ent.split(":", 1)[1]
            stat = route_stats.setdefault(route, {
                "read": 0, "write": 0, "create": 0, "fns": set(),
            })
            if ev[2] & ROLE_CREATE:
                stat["create"] += 1
            if ev[2] & ROLE_WRITE:
                stat["write"] += 1
            if ev[2] & ROLE_READ:
                stat["read"] += 1
            stat["fns"].add(ev[0])
        if route_stats:
            rec["routes"] = sorted(
                [[route, s["read"], s["write"], s["create"], len(s["fns"])]
                 for route, s in route_stats.items()],
                key=lambda r: (-(r[1] + r[2] + r[3]), -r[4], r[0]),
            )

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

    # Search index: fields, parameters, module variables/locals and types.
    search_rows: list[list] = []
    seen_keys: set[tuple[str, str]] = set()
    kind_rank = {"field": 0, "param": 1, "var": 2, "struct": 3, "local": 4}
    for gid, rec in groups.items():
        members = rec["entities"]
        counts = rec["counts"]
        names: set[str] = set()
        kind = rec["kind"]
        if kind not in kind_rank:
            continue
        if kind == "field":
            body = rec.get("member") or rec["entity"].split(":", 1)[1]
            leaf = body.split("%")[-1]
            names.add(body)
            names.add("%" + leaf)
            names.add(leaf)
            for route in rec.get("routes") or []:
                names.add(route[0])
            row_type = rec.get("declaringType") or ""
            row_member = body
        else:
            body = rec["entity"].split(":", 1)[1]
            if kind == "param":
                owner, _, pname = body.rpartition("::")
                names.add(body)
                names.add(pname)
                if owner:
                    names.add(owner.rsplit("::", 1)[-1] + "::" + pname)
            else:
                names.add(body)
                names.add(body.rsplit("::", 1)[-1])
            row_type = decl_type(rec["entity"]) or ""
            row_member = ""
        for name in names:
            key = (name, gid)
            if not name or key in seen_keys:
                continue
            seen_keys.add(key)
            search_rows.append([name, gid, kind_rank.get(kind, 9),
                                counts["read"], counts["write"],
                                row_type, row_member, counts["functions"]])
    # One row per type so `@cartesian_center` also offers its declaring type.
    for type_key, rec in registry.records.items():
        names = {type_key}
        if rec.get("module"):
            names.add(rec["module"] + "::" + type_key)
        total_read = total_write = total_fns = 0
        for group in groups.values():
            if group.get("declaringType") == type_key:
                total_read += group["counts"]["read"]
                total_write += group["counts"]["write"]
                total_fns = max(total_fns, group["counts"]["functions"])
        for name in names:
            key = (name, type_key)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            search_rows.append([name, type_key, kind_rank["struct"],
                                total_read, total_write, type_key, "", total_fns])
    # For a name shared by a type and many parameters/variables, the type row
    # must come first: the browser scans a bounded prefix window and would
    # otherwise never reach it (`@patch` with hundreds of Fortran arguments).
    search_rows.sort(key=lambda r: (
        r[0], 0 if r[2] == kind_rank["struct"] else 1, r[2],
        -r[3] - r[4], r[1],
    ))

    member_routes = {rec["member"]: rec.get("routes", [])
                     for rec in groups.values() if rec.get("member")}
    type_totals: dict[str, dict] = {}
    for rec in groups.values():
        key = rec.get("declaringType")
        if not key:
            continue
        total = type_totals.setdefault(key, {"read": 0, "write": 0,
                                             "create": 0, "functions": 0})
        total["read"] += rec["counts"]["read"]
        total["write"] += rec["counts"]["write"]
        total["create"] += rec["counts"]["create"]
        total["functions"] = max(total["functions"], rec["counts"]["functions"])

    return TraceBuild(groups=groups, group_of=group_of, shard_of=shard_of,
                      search=search_rows, events_total=sum(len(r["events"]) for r in groups.values()),
                      member_routes=member_routes, member_gid=member_gid,
                      type_totals=type_totals, registry=registry)


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

def _has_trace_path(chain: list[list] | None) -> bool:
    """True when a backward chain contains a real link to a caller.

    ``_build_backward`` always starts with a synthetic owner step (line 0,
    upstream -1). A single such step means the extractor found neither an
    incoming pass nor a direct event, so there is nothing to trace.
    """
    if not chain:
        return False
    first = chain[0] or []
    if len(chain) > 1:
        return True
    return bool(first[1]) or (len(first) > 4 and first[4] is not None and first[4] >= 0)


def _entity_event_count(group: dict, entity: str) -> int:
    """Count event rows whose entity is exactly ``entity`` (not a merged alias)."""
    entities = group.get("entities") or []
    try:
        index = entities.index(entity)
    except ValueError:
        return 0
    return sum(1 for ev in group.get("events") or [] if len(ev) > 4 and ev[4] == index)


def build_function_shards(source: dict, graph: dict, trace: TraceBuild,
                          vis_dir: str) -> dict:
    functions = source["functions"]
    registry = TypeRegistry(source["types"])
    node_by_fn = graph["nodeByFunction"]
    file_meta = source.get("file_meta", {})
    model_root = source.get("model_root") or ""
    components = graph["components"]
    shards = graph["fnShards"]
    comp_index = {c: i for i, c in enumerate(components)}
    payloads: list[dict] = [dict() for _ in shards]

    # Incoming pass sites per formal parameter, used only to explain where a
    # parameter without events came from. Deduplicate repeated call rows.
    incoming_sources: dict[str, list[dict]] = defaultdict(list)
    seen_sources: dict[str, set[tuple[str, int]]] = defaultdict(set)
    for p in source.get("passes") or []:
        formal = canonical_field_entity(p.get("formal") or "", registry)
        if not formal:
            continue
        caller = p.get("caller")
        line = p.get("line") or 0
        key = (caller, line)
        if key in seen_sources[formal]:
            continue
        seen_sources[formal].add(key)
        caller_proc = functions.get(caller) or {}
        caller_file = (file_meta.get(caller_proc.get("file") or "", {}) or {}).get("rel_path")
        incoming_sources[formal].append({
            "n": caller_proc.get("name") or caller,
            "f": caller_file or _rel(caller_proc.get("file"), model_root),
            "l": line,
        })

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
            entity = canonical_field_entity(f"param:{pid}::{pname}", registry)
            gid = trace.group_of.get(entity)
            flags = 0
            for flag, key in ((1, "optional"), (2, "pointer"), (4, "allocatable"),
                              (8, "target"), (16, "value"), (32, "save"),
                              (64, "by_ref"), (128, "const")):
                if p.get(key):
                    flags |= flag
            param_row = {
                "n": pname,
                "t": p.get("type"),
                "r": p.get("rank") or 0,
                "i": _norm_intent(p.get("intent")),
                "ii": _norm_intent(p.get("inferred_intent")),
                "f": flags,
                "g": gid,
                "l": p.get("line"),
            }
            group = trace.groups.get(gid) or {}
            chain = (group.get("backward") or {}).get(entity)
            if not _has_trace_path(chain) and not _entity_event_count(group, entity):
                # Declared and possibly passed in, but the extractor recorded no
                # read/write/pass event with a usable source location.
                param_row["np"] = 1
                sources = sorted(
                    incoming_sources.get(entity, []),
                    key=lambda s: (s.get("l") or 0, s.get("n") or ""),
                )[:8]
                if sources:
                    param_row["src"] = sources
            params.append(param_row)
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
            "routes": rec.get("routes", []),
            "member": rec.get("member"),
            "declaringType": rec.get("declaringType"),
            "unresolved": rec.get("unresolved", False),
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


# --------------------------------------------------------------------------- #
# struct / variable explorer data
# --------------------------------------------------------------------------- #

STRUCT_SHARDS = 32


def _struct_shard(key: str) -> str:
    return f"struct/{(int(_sha1(key)[:8], 16) % STRUCT_SHARDS):02x}.json"


def _field_flags(field: dict) -> list[str]:
    flags = []
    for name, key in (("pointer", "pointer"), ("allocatable", "allocatable"),
                      ("target", "target"), ("optional", "optional"),
                      ("value", "value"), ("parameter", "parameter"),
                      ("save", "save"), ("class", "class")):
        if field.get(key):
            flags.append(name)
    return flags


def _empty_touch() -> dict:
    return {"fn": {}, "edges": set(), "origin": None,
            "folders": defaultdict(int), "files": defaultdict(int)}


def _merge_touch(dst: dict, src: dict) -> dict:
    for node, mask in src["fn"].items():
        dst["fn"][node] = dst["fn"].get(node, 0) | mask
    dst["edges"].update(src["edges"])
    if dst["origin"] is None and src.get("origin"):
        dst["origin"] = src["origin"]
    for key, value in src["folders"].items():
        dst["folders"][key] += value
    for key, value in src["files"].items():
        dst["files"][key] += value
    return dst


def _group_touch(rec: dict) -> dict:
    touch = _empty_touch()
    if not rec:
        return touch
    for ev in rec.get("events") or []:
        node = ev[0]
        touch["fn"][node] = touch["fn"].get(node, 0) | ev[2]
        other = ev[5] if len(ev) > 5 else -1
        if (ev[2] & ROLE_PASS) and other is not None and other >= 0:
            touch["edges"].add((node, other))
    origin = rec.get("origin") or {}
    if origin.get("node") is not None:
        touch["origin"] = [origin.get("node"), origin.get("line") or 0,
                           origin.get("file"), origin.get("name")]
    for key, value in rec.get("folders") or []:
        touch["folders"][key] += value
    for key, value in rec.get("files") or []:
        touch["files"][key] += value
    return touch


def _touch_payload(touch: dict) -> dict:
    return {
        "fn": sorted([int(node), int(mask)] for node, mask in touch["fn"].items()),
        "edges": sorted([int(a), int(b)] for a, b in touch["edges"]),
        "origin": touch.get("origin"),
        "folders": sorted(touch["folders"].items(), key=lambda kv: (-kv[1], kv[0]))[:40],
        "files": sorted(touch["files"].items(), key=lambda kv: (-kv[1], kv[0]))[:80],
    }


def build_structs(source: dict, trace: TraceBuild, graph: dict,
                  vis_dir: str) -> dict:
    """Write ``structs.json`` and lazy touch shards; return summary counts."""
    registry = trace.registry or TypeRegistry(source["types"])
    functions = source["functions"]
    member_group = trace.member_gid

    # --- holders (variables / parameters / locals of each type) -----------
    holders: dict[str, list[dict]] = defaultdict(list)
    seen_holder: set[tuple[str, str]] = set()
    variables = list(source.get("variables") or [])
    for pid, proc in functions.items():
        for p in proc.get("params") or []:
            variables.append({
                "id": f"param:{pid}::{p.get('name')}",
                "kind": "param", "name": p.get("name"), "scope": pid,
                "module": proc.get("module"), "type": p.get("type"),
                "line": p.get("line"), "file": proc.get("file"),
            })
    for var in variables:
        type_key = _base_type_name(var.get("type"))
        if not type_key or registry.get(type_key) is None:
            continue
        vid = var.get("id") or f"{var.get('kind')}:{var.get('scope')}::{var.get('name')}"
        if (type_key, vid) in seen_holder:
            continue
        seen_holder.add((type_key, vid))
        gid = trace.group_of.get(vid)
        rec = trace.groups.get(gid) or {}
        sample = []
        if rec:
            for ev in rec.get("events") or []:
                fn_id = graph["ids"][ev[0]] if ev[0] < len(graph["ids"]) else None
                name = functions.get(fn_id, {}).get("name") if fn_id else None
                if name and name not in sample:
                    sample.append(name)
                if len(sample) >= 3:
                    break
        kind = {"param": "parameter", "var": "module variable",
                "local": "local"}.get(var.get("kind"), var.get("kind") or "variable")
        holders[type_key].append({
            "id": vid, "name": var.get("name"), "kind": kind,
            "scope": var.get("scope"), "module": var.get("module"),
            "line": var.get("line"),
            "file": _rel(var.get("file"), source.get("model_root")),
            "count": (rec.get("counts") or {}).get("functions", 0),
            "fns": sample,
        })
    for type_key in holders:
        # Collapse repeated dummy arguments of the same name: the chip list is
        # "known as", not a function inventory.
        collapsed: dict[tuple, dict] = {}
        for holder in holders[type_key]:
            key = (holder["name"],)
            kept = collapsed.get(key)
            if kept is None or holder["count"] > kept["count"]:
                collapsed[key] = holder
        holders[type_key] = sorted(collapsed.values(),
                                   key=lambda h: (-h["count"], h["name"] or "", h["id"]))

    # --- containment edges ------------------------------------------------
    parents: dict[str, list] = defaultdict(list)
    for type_key, rec in registry.records.items():
        for field in rec.get("fields") or []:
            child = _base_type_name(field.get("type"))
            if child and registry.get(child) is not None:
                parents[child].append([type_key, (field.get("name") or "").lower()])

    # --- touch sets, rolled up through containment ------------------------
    def field_member(field: dict) -> str:
        return f"{field['declaring']}%{field['name']}"

    def member_touch(member: str) -> dict:
        gid = member_group.get(member)
        return _group_touch(trace.groups.get(gid) or {})

    rollup_cache: dict[str, dict] = {}

    def rollup(type_key: str, visiting: set[str]) -> tuple[dict, bool]:
        if type_key in rollup_cache:
            return rollup_cache[type_key], True
        if type_key in visiting or registry.get(type_key) is None:
            return _empty_touch(), False
        visiting = set(visiting)
        visiting.add(type_key)
        touch = _empty_touch()
        clean = True
        rec = registry.get(type_key) or {}
        for field in registry.fields_with_owner(type_key):
            member = field_member(field)
            merged = member_touch(member)
            child = _base_type_name(field.get("type"))
            if child and registry.get(child) is not None and not registry.is_value(child):
                sub, sub_clean = rollup(child, visiting)
                _merge_touch(merged, sub)
                clean = clean and sub_clean
            _merge_touch(touch, merged)
        if clean:
            rollup_cache[type_key] = touch
        return touch, clean

    touch_shards: dict[str, dict] = defaultdict(dict)
    for type_key, rec in registry.records.items():
        roll, _clean = rollup(type_key, set())
        members = {}
        for field in registry.fields_with_owner(type_key):
            member = field_member(field)
            merged = member_touch(member)
            child = _base_type_name(field.get("type"))
            if child and registry.get(child) is not None and not registry.is_value(child):
                sub, _ = rollup(child, {type_key})
                _merge_touch(merged, sub)
            members[member] = _touch_payload(merged)
        payload = _touch_payload(roll)
        payload["members"] = members
        touch_shards[_struct_shard(type_key)][type_key] = payload

    # --- reverse index: which data does a function touch? -----------------
    fn_usage: dict[int, dict[tuple, int]] = defaultdict(dict)
    for gid, rec in trace.groups.items():
        kind = rec.get("kind")
        if kind == "field":
            key = rec.get("member") or rec["entity"].split(":", 1)[1]
            entry_kind = 0
        elif kind in ("param", "var", "local"):
            key = rec["entity"]
            entry_kind = 1
        else:
            continue
        for ev in rec.get("events") or []:
            node = ev[0]
            k = (entry_kind, key, gid)
            fn_usage[node][k] = fn_usage[node].get(k, 0) | ev[2]
    fn_shards: dict[str, dict] = defaultdict(dict)
    for node, entries in fn_usage.items():
        shard = f"struct/fn/{node % STRUCT_SHARDS:02x}.json"
        fn_shards[shard][node] = sorted(
            [[k[0], k[1], k[2], mask] for k, mask in entries.items()],
            key=lambda r: (-r[3], r[1]))

    # --- route rollups for struct members without their own group ----------
    # ``t_patch%cells`` has no direct access of its own; its usage is the union
    # of every ``t_patch%cells%…`` route. Index every prefix once so the type
    # page can still show a route table for such a member.
    aggregate_routes: dict[str, dict] = defaultdict(lambda: defaultdict(
        lambda: {"read": 0, "write": 0, "create": 0, "fns": 0}))
    for rec in trace.groups.values():
        for route, reads, writes, creates, fns in rec.get("routes") or []:
            parts = route.split("%")
            for i in range(2, len(parts) + 1):
                prefix = "%".join(parts[:i])
                stat = aggregate_routes[prefix][route]
                stat["read"] += reads
                stat["write"] += writes
                stat["create"] += creates
                stat["fns"] = max(stat["fns"], fns)

    def routes_for_member(member: str) -> list[list]:
        own = trace.member_routes.get(member)
        if own:
            return own
        stats = aggregate_routes.get(member) or {}
        return sorted(
            [[route, s["read"], s["write"], s["create"], s["fns"]]
             for route, s in stats.items()],
            key=lambda r: (-(r[1] + r[2] + r[3]), -r[4], r[0]),
        )

    # --- type pages -------------------------------------------------------
    types_payload: dict[str, dict] = {}
    for type_key, rec in registry.records.items():
        fields = []
        for field in registry.fields_with_owner(type_key):
            member = field_member(field)
            owner_rec = registry.get(field["declaring"]) or {}
            fields.append({
                "name": field["name"],
                "type": _base_type_name(field.get("type")) or "",
                "rawType": field.get("type") or "",
                "rank": field.get("rank") or 0,
                "flags": _field_flags(field),
                "line": _find_component_line(
                    owner_rec.get("file"), owner_rec.get("name") or field["declaring"],
                    field["name"], field.get("line")),
                "member": member,
                "owner": field["declaring"],
                "inheritedFrom": field.get("inheritedFrom"),
                "gid": member_group.get(member),
                "value": bool(field.get("type") and registry.is_value(
                    _base_type_name(field.get("type")))),
            })
        total = trace.type_totals.get(type_key, {})
        types_payload[type_key] = {
            "name": rec["name"],
            "module": rec.get("module"),
            "file": _rel(rec.get("file"), source.get("model_root")),
            "line": rec.get("line"),
            "extends": rec.get("extends"),
            "value": registry.is_value(type_key),
            "fields": fields,
            "parents": sorted(parents.get(type_key, [])),
            "holders": holders.get(type_key, []),
            "routes": {
                field["member"]: routes_for_member(field["member"])
                for field in fields
            },
            "counts": {
                "read": total.get("read", 0), "write": total.get("write", 0),
                "create": total.get("create", 0),
                "functions": total.get("functions", 0),
            },
            "shard": _struct_shard(type_key),
        }

    unresolved = []
    for gid, rec in trace.groups.items():
        if not rec.get("unresolved"):
            continue
        unresolved.append({
            "route": rec["entity"].split(":", 1)[1],
            "gid": gid,
            "reads": rec["counts"]["read"],
            "writes": rec["counts"]["write"],
            "functions": rec["counts"]["functions"],
        })
    unresolved.sort(key=lambda r: (-r["reads"] - r["writes"], r["route"]))

    payload = {
        "version": 1,
        "types": types_payload,
        "unresolved": unresolved[:5000],
        "shards": sorted(touch_shards.keys()) + sorted(fn_shards.keys()),
    }
    sizes = _write_json(os.path.join(vis_dir, "structs.json"), payload)

    shard_count = 0
    for shard, content in touch_shards.items():
        _write_json(os.path.join(vis_dir, shard), {"types": content})
        shard_count += 1
    for shard, content in fn_shards.items():
        _write_json(os.path.join(vis_dir, shard), {"functions": content})
        shard_count += 1

    return {
        "types": len(types_payload),
        "values": sum(1 for rec in types_payload.values() if rec["value"]),
        "unresolved": len(unresolved),
        "touchShards": shard_count,
        "bytes": sizes.get("br", sizes["raw"]),
    }


def build_search_index(trace: TraceBuild, vis_dir: str) -> dict:
    rows = trace.search
    payload = {
        "names": [r[0] for r in rows],
        "groups": [r[1] for r in rows],
        "kinds": [r[2] for r in rows],
        "reads": [r[3] for r in rows],
        "writes": [r[4] for r in rows],
        "types": [r[5] if len(r) > 5 else "" for r in rows],
        "members": [r[6] if len(r) > 6 else "" for r in rows],
        "fns": [r[7] if len(r) > 7 else 0 for r in rows],
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
    for sub in ("fn", "trace", "struct"):
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
    result["structs"] = build_structs(source, trace, graph, vis_dir)
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
        st = res.get("structs") or {}
        print(f"structs: {st.get('types', 0)} types ({st.get('values', 0)} value types), "
              f"{st.get('unresolved', 0)} unresolved field routes, "
              f"{st.get('touchShards', 0)} touch shards")
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
