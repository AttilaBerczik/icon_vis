"""Global symbol table over merged per-file facts."""

from __future__ import annotations

import re
from collections import defaultdict


def _merge_unique(items: list, key_fn) -> list:
    seen = set()
    out = []
    for item in items:
        k = key_fn(item)
        if k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out


def merge_profile_facts(file_facts: list[dict]) -> dict:
    """Merge the same source file parsed under several build profiles.

    Facts are sorted by profile name first so that merging (and therefore all
    downstream symbol resolution) is deterministic regardless of which worker
    finished first.
    """
    if not file_facts:
        return {}
    file_facts = sorted(file_facts, key=lambda f: (f.get("profile") or ""))
    if len(file_facts) == 1:
        f = dict(file_facts[0])
        f["profiles"] = [f.get("profile")]
        return f
    base = dict(file_facts[0])
    profiles = sorted({f.get("profile") for f in file_facts if f.get("profile")})
    base["profiles"] = profiles
    base["diagnostics"] = _merge_unique(
        [d for f in file_facts for d in f.get("diagnostics", [])], lambda x: x
    )
    base["errors"] = _merge_unique(
        [d for f in file_facts for d in f.get("errors", [])], lambda x: x
    )
    if any(f.get("parser_ok") for f in file_facts):
        base["parser_ok"] = True
    # Keep the best parser tier.
    tier_rank = {"fparser": 0, "treesitter": 1, "cpp": 0, "regex": 2}
    base["tier"] = min((f.get("tier", "regex") for f in file_facts), key=lambda t: tier_rank.get(t, 9))

    # Modules by name.
    mods: dict[str, dict] = {}
    for f in file_facts:
        for m in f.get("modules", []):
            mods.setdefault(m["name"], dict(m))
            mods[m["name"]]["uses"] = _merge_unique(
                [*mods[m["name"]].get("uses", []), *m.get("uses", [])],
                lambda u: (u.get("module"), repr(u.get("only"))),
            )
            mods[m["name"]]["interfaces"] = _merge_unique(
                [*mods[m["name"]].get("interfaces", []), *m.get("interfaces", [])],
                lambda i: (i.get("name"), tuple(i.get("procedures", []))),
            )
    base["modules"] = list(mods.values())

    # Procedures by id.
    procs: dict[str, dict] = {}
    for f in file_facts:
        for p in f.get("procedures", []):
            if p["id"] not in procs:
                procs[p["id"]] = dict(p)
                procs[p["id"]]["profiles"] = [f.get("profile")]
                continue
            dst = procs[p["id"]]
            dst["profiles"] = sorted(set(dst.get("profiles", [])) | {f.get("profile")})
            for key in ("params", "decls"):
                dst[key] = _merge_unique([*dst.get(key, []), *p.get(key, [])], lambda d: d.get("name"))
            dst["uses"] = _merge_unique(
                [*dst.get("uses", []), *p.get("uses", [])],
                lambda u: (u.get("module"), repr(u.get("only"))),
            )
            dst["aliases"] = _merge_unique(
                [*dst.get("aliases", []), *p.get("aliases", [])],
                lambda a: (a.get("left"), a.get("right"), a.get("line")),
            )
            dst["stmts"] = _merge_unique(
                [*dst.get("stmts", []), *p.get("stmts", [])],
                lambda s: (s.get("op"), s.get("line"), s.get("lhs"), s.get("callee"),
                           tuple((a.get("keyword"), a.get("path")) for a in s.get("args", []))),
            )
            dst["exec_markers"] = _merge_unique(
                [*dst.get("exec_markers", []), *p.get("exec_markers", [])],
                lambda m: (m.get("macro"), m.get("space"), m.get("orig_line"), m.get("line")),
            )
    base["procedures"] = list(procs.values())

    types: dict[tuple, dict] = {}
    for f in file_facts:
        for t in f.get("types", []):
            key = (t.get("name"), t.get("module"), t.get("line"))
            if key not in types:
                types[key] = dict(t)
            else:
                dst = types[key]
                dst["fields"] = _merge_unique([*dst.get("fields", []), *t.get("fields", [])],
                                              lambda d: d.get("name"))
                dst["bindings"] = _merge_unique([*dst.get("bindings", []), *t.get("bindings", [])],
                                                lambda d: (d.get("name"), d.get("target")))
    base["types"] = list(types.values())

    mv: dict[tuple, dict] = {}
    for f in file_facts:
        for v in f.get("module_vars", []):
            mv[(v.get("module"), v.get("name"))] = v
    base["module_vars"] = list(mv.values())

    base["directives"] = _merge_unique(
        [d for f in file_facts for d in f.get("directives", [])],
        lambda d: (d.get("kind"), d.get("directive"), d.get("line"), d.get("raw")),
    )
    return base


class SymbolTable:
    def __init__(self, file_facts: list[dict]):
        self.files = file_facts
        self.modules: dict[str, dict] = {}
        self.procs: dict[str, dict] = {}
        self.proc_by_name: dict[str, list[str]] = defaultdict(list)
        self.proc_by_module: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        self.file_procs: dict[str, list[str]] = defaultdict(list)
        self.types: dict[str, list[dict]] = defaultdict(list)
        self.module_vars: dict[str, dict[str, dict]] = defaultdict(dict)
        self.generic: dict[tuple[str, str], list[str]] = {}
        self.bindings: dict[str, list[dict]] = defaultdict(list)
        self.bind_c: dict[str, list[str]] = defaultdict(list)
        self.cpp_by_name: dict[str, list[str]] = defaultdict(list)
        self.used_modules: dict[str, list[dict]] = defaultdict(list)

        for f in file_facts:
            rel = f.get("rel_path", f.get("file", ""))
            for m in f.get("modules", []):
                name = m["name"]
                mod = self.modules.setdefault(name, {
                    "name": name, "file": f.get("file"), "rel_path": rel,
                    "uses": [], "interfaces": [], "default_private": False,
                    "public": [], "private": [], "lang": f.get("lang"),
                })
                mod["uses"] = _merge_unique([*mod["uses"], *m.get("uses", [])],
                                            lambda u: (u.get("module"), repr(u.get("only"))))
                mod["interfaces"] = _merge_unique([*mod["interfaces"], *m.get("interfaces", [])],
                                                  lambda i: i.get("name"))
                mod["default_private"] = mod["default_private"] or m.get("default_private", False)
                mod["public"] = list(set([*mod["public"], *m.get("public", [])]))
                mod["private"] = list(set([*mod["private"], *m.get("private", [])]))
                self.used_modules[name] = mod["uses"]
                for iface in m.get("interfaces", []):
                    self.generic[(name, iface["name"])] = iface.get("procedures", [])

            for t in f.get("types", []):
                self.types[t["name"]].append(t)
                for b in t.get("bindings", []):
                    self.bindings[t["name"]].append({**b, "type_module": t.get("module")})
                for gname, targets in (t.get("generic_bindings") or {}).items():
                    self.bindings[t["name"]].append({
                        "name": gname, "target": None, "generic": targets,
                        "type_module": t.get("module"),
                    })

            for v in f.get("module_vars", []):
                self.module_vars[v.get("module", "")][v["name"]] = v

            for p in f.get("procedures", []):
                pid = p["id"]
                self.procs[pid] = p
                self.proc_by_name[p["name"]].append(pid)
                if p.get("module"):
                    self.proc_by_module[p["module"]][p["name"]].append(pid)
                self.file_procs[p.get("file", rel)].append(pid)
                if p.get("bind_c"):
                    self.bind_c[p["bind_c"]].append(pid)
                if p.get("lang") == "cpp":
                    self.cpp_by_name[p["name"]].append(pid)
                    q = p.get("qualified")
                    if q:
                        self.cpp_by_name[q.split("::")[-1]].append(pid)

        # Keep insertion order but drop duplicate ids in name indexes.
        for k, v in list(self.proc_by_name.items()):
            self.proc_by_name[k] = list(dict.fromkeys(v))
        for m in self.proc_by_module.values():
            for k, v in list(m.items()):
                m[k] = list(dict.fromkeys(v))
        for name, ids in self.cpp_by_name.items():
            self.cpp_by_name[name] = list(dict.fromkeys(ids))
        self.proc_by_name = dict(self.proc_by_name)
        self.cpp_by_name = dict(self.cpp_by_name)
        self.proc_by_module = {k: dict(v) for k, v in self.proc_by_module.items()}
        self.types = dict(self.types)
        self.module_vars = {k: dict(v) for k, v in self.module_vars.items()}
        self.bindings = dict(self.bindings)
        self.bind_c = dict(self.bind_c)
        self.file_procs = dict(self.file_procs)
        self.used_modules = dict(self.used_modules)
        self._type_by_module = {}
        for name, lst in self.types.items():
            for t in lst:
                self._type_by_module.setdefault((t.get("module"), name), t)

    # ------------------------------------------------------------------ utils
    def type_info(self, name: str, module: str | None = None) -> dict | None:
        name = (name or "").lower()
        if module and (module, name) in self._type_by_module:
            return self._type_by_module[(module, name)]
        lst = self.types.get(name)
        if lst:
            return lst[0]
        # Type imported/renamed through USE: find a local alias.
        return None

    def type_chain(self, name: str, module: str | None = None) -> list[dict]:
        chain = []
        seen = set()
        cur = name
        while cur and cur not in seen:
            seen.add(cur)
            t = self.type_info(cur, module if not chain else None)
            if not t:
                break
            chain.append(t)
            cur = t.get("extends")
        return chain

    def binding_targets(self, type_name: str, method: str) -> list[str]:
        """Resolve a type-bound method name to target procedure names."""
        targets: list[str] = []
        for t in self.type_chain(type_name):
            for b in self.bindings.get(t["name"], []):
                if b.get("name") != method:
                    continue
                if b.get("target"):
                    targets.append(b["target"])
                for g in b.get("generic") or []:
                    targets.append(g)
                if b.get("deferred") or (not b.get("target") and not b.get("generic")):
                    # Deferred binding: all overrides in subtypes.
                    targets.extend(self._overrides(t["name"], method))
        return list(dict.fromkeys(targets))

    def _overrides(self, base: str, method: str) -> list[str]:
        out = []
        for name, lst in self.types.items():
            for t in lst:
                chain = [x.get("extends") for x in self.type_chain(name, t.get("module"))]
                if base not in chain:
                    continue
                for b in self.bindings.get(name, []):
                    if b.get("name") == method and b.get("target"):
                        out.append(b["target"])
        return out

    def subtypes(self, base: str) -> list[str]:
        out = []
        for name, lst in self.types.items():
            if name == base:
                continue
            for t in lst:
                chain = [x.get("extends") for x in self.type_chain(name, t.get("module"))]
                if base in chain:
                    out.append(name)
                    break
        return out

    def visible_uses(self, module: str | None) -> list[dict]:
        return self.used_modules.get(module or "", [])

    def resolve_import(self, module: str | None, local: str) -> tuple[str, str | None]:
        """Resolve a name imported by USE into (name, defining module)."""
        local = local.lower()
        for use in self.visible_uses(module):
            only = use.get("only")
            if only is not None:
                if local in only:
                    orig = only[local]
                    return orig, use["module"]
                continue
            return local, use["module"]
        return local, module

    def find_procs(self, name: str, module: str | None = None, caller_id: str | None = None,
                   used_module: str | None = None) -> list[str]:
        name = name.lower()
        ids: list[str] = []
        # Contained procedure of the caller.
        if caller_id:
            candidate = f"{caller_id}::{name}"
            if candidate in self.procs:
                return [candidate]
            # Host-contained in the same module.
            if module:
                prefix = f"{module}::"
                for pid, p in self.procs.items():
                    if pid.startswith(prefix) and p["name"] == name and p.get("module") == module:
                        ids.append(pid)
        if module:
            ids.extend(self.proc_by_module.get(module, {}).get(name, []))
            if (module, name) in self.generic:
                return self._generic_ids(module, name)
        if used_module:
            ids.extend(self.proc_by_module.get(used_module, {}).get(name, []))
            if (used_module, name) in self.generic:
                ids.extend(self._generic_ids(used_module, name))
        if ids:
            return list(dict.fromkeys(ids))
        # Fallback: unique definition anywhere (external file-local procedures).
        ids = self.proc_by_name.get(name, [])
        return list(dict.fromkeys(ids))

    def _generic_ids(self, module: str, name: str) -> list[str]:
        out = []
        for target in self.generic.get((module, name), []):
            out.extend(self.proc_by_module.get(module, {}).get(target, []))
            if not self.proc_by_module.get(module, {}).get(target):
                out.extend(self.proc_by_name.get(target, []))
        return list(dict.fromkeys(out))

    def lookup_cpp(self, name: str) -> list[str]:
        name = (name or "").lower()
        return self.cpp_by_name.get(name, [])
