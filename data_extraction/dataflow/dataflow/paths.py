"""Field-path normalisation and may-alias resolution."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .symtab import SymbolTable


@dataclass
class ResolvedPath:
    entity: str
    path: str
    root: str
    root_kind: str  # param | local | module | this | unknown
    type: str | None
    fields: list[str]
    scope: str


def _split(path: str) -> list[str]:
    return [p.lower() for p in path.split("%") if p]


def _decl_map(proc: dict) -> dict[str, dict]:
    out = {}
    for d in proc.get("decls", []) + proc.get("params", []):
        out.setdefault(d["name"], d)
    return out


class PathResolver:
    def __init__(self, sym: SymbolTable, proc: dict):
        self.sym = sym
        self.proc = proc
        self.module = proc.get("module")
        self.decls = _decl_map(proc)
        self.aliases: dict[str, str] = {}
        for a in proc.get("aliases", []):
            left, right = a.get("left"), a.get("right")
            if left and right:
                self.aliases[left] = right
        self.this_type = self._find_this_type()
        self._alias_leaf_type_cache: dict[str, str | None] = {}

    def _find_this_type(self) -> str | None:
        explicit = self.proc.get("class")
        if explicit:
            return explicit.lower()
        q = self.proc.get("qualified") or ""
        if "::" in q:
            parts = q.split("::")
            if len(parts) >= 2:
                return parts[-2].lower()
        return None

    def _module_var(self, root: str) -> tuple[dict | None, str | None]:
        if not self.module:
            return None, None
        if root in self.sym.module_vars.get(self.module, {}):
            return self.sym.module_vars[self.module][root], self.module
        for use in self.sym.visible_uses(self.module):
            used = use.get("module")
            only = use.get("only")
            if only is not None and root not in only:
                continue
            orig = only[root] if only is not None else root
            if orig in self.sym.module_vars.get(used, {}):
                return self.sym.module_vars[used][orig], used
        return None, None

    def _expand_alias(self, path: str) -> str:
        return self._expand_alias_details(path)[0]

    def _expand_alias_details(self, path: str) -> tuple[str, str | None, list[str]]:
        """Return (expanded path, alias prefix used, fields after the alias)."""
        parts = _split(path)
        for i in range(len(parts), 0, -1):
            prefix = "%".join(parts[:i])
            if prefix in self.aliases:
                right = self.aliases[prefix]
                return ("%".join([*_split(right), *parts[i:]]), prefix, parts[i:])
        return path, None, []

    def _decl_type(self, root: str) -> str | None:
        decl = self.decls.get(root)
        if decl is None:
            mv, _mod = self._module_var(root)
            decl = mv
        if decl is None and root == "this":
            return self.this_type
        type_name = (decl or {}).get("type")
        type_name = (type_name or "").split("::")[-1].lower()
        if type_name and not self.sym.type_info(type_name):
            orig, _ = self.sym.resolve_import(self.module, type_name)
            if self.sym.type_info(orig):
                type_name = orig
        return type_name or None

    def _leaf_type(self, root: str, fields: list[str]) -> str | None:
        type_name = self._decl_type(root)
        if not type_name:
            return None
        for field in fields:
            found = None
            for t in self.sym.type_chain(type_name):
                for f in t.get("fields", []):
                    if f.get("name") == field:
                        found = f
                        break
                if found:
                    break
            if not found:
                return type_name
            type_name = (found.get("type") or "").split("::")[-1].lower()
        return type_name or None

    def _alias_leaf_type(self, prefix: str) -> str | None:
        if prefix in self._alias_leaf_type_cache:
            return self._alias_leaf_type_cache[prefix]
        right = self.aliases.get(prefix, "")
        parts = _split(right)
        leaf = self._leaf_type(parts[0], parts[1:]) if parts else None
        self._alias_leaf_type_cache[prefix] = leaf
        return leaf

    def resolve(self, path: str, proc_id: str) -> ResolvedPath:
        raw = (path or "").lower()
        expanded, alias_prefix, remaining = self._expand_alias_details(raw)
        parts = _split(expanded)
        if not parts:
            return ResolvedPath("unknown", raw, raw, "unknown", None, [], proc_id)
        root = parts[0]
        fields = parts[1:]

        decl = self.decls.get(root)
        root_kind = "param" if decl is not None and any(
            p.get("name") == root for p in self.proc.get("params", [])
        ) else "local"
        module_var = None
        mv_module = None
        if decl is None:
            mv, mv_module = self._module_var(root)
            if mv is not None:
                decl = mv
                module_var = mv
                root_kind = "module"
        if root == "this" and decl is None:
            decl = {"name": "this", "type": self.this_type or "", "rank": 0}
            root_kind = "this"

        type_name = (decl or {}).get("type")
        type_name = (type_name or "").split("::")[-1].lower()
        # Resolve a type imported through USE renaming.
        if type_name and not self.sym.type_info(type_name):
            orig, _ = self.sym.resolve_import(self.module, type_name)
            if self.sym.type_info(orig):
                type_name = orig

        scope = mv_module or self.module or proc_id
        if root_kind == "module":
            base_entity = f"var:{scope}::{root}"
        elif root_kind == "param":
            base_entity = f"param:{proc_id}::{root}"
        elif root_kind == "this":
            base_entity = f"this:{type_name}"
        else:
            base_entity = f"local:{proc_id}::{root}"

        # A pointer/ASSOCIATE alias whose target is a derived-type component:
        # canonicalise to the *leaf* type of the alias target, with the
        # remaining fields. `p_patch => p_patch_3d(jg)%p_patch_2d; p_patch%cells`
        # then becomes `field:t_patch%cells`, not `t_patch_3d%p_patch_2d%cells`.
        if alias_prefix and remaining:
            alias_type = self._alias_leaf_type(alias_prefix)
            if alias_type and self.sym.type_info(alias_type):
                entity = f"field:{alias_type}%" + "%".join(remaining)
                return ResolvedPath(entity, expanded, root, root_kind, alias_type,
                                    remaining, scope)
        if fields and self.sym.type_info(type_name):
            # Typed field path: one entity for the whole code base.
            entity = f"field:{type_name}%" + "%".join(fields)
            return ResolvedPath(entity, expanded, root, root_kind, type_name, fields, scope)
        if fields:
            entity = f"{base_entity}%" + "%".join(fields)
            return ResolvedPath(entity, expanded, root, root_kind, type_name, fields, scope)
        return ResolvedPath(base_entity, expanded, root, root_kind, type_name, fields, scope)

    def secondary_entity(self, rp: ResolvedPath) -> str | None:
        """The parameter/global entity alongside a typed field entity."""
        if rp.fields and rp.root_kind in ("param", "module", "this"):
            if rp.root_kind == "param":
                return f"param:{self.proc['id']}::{rp.root}"
            if rp.root_kind == "module":
                return f"var:{rp.scope}::{rp.root}"
            return f"this:{rp.type}"
        return None


def extract_paths_from_text(text: str) -> list[str]:
    out = []
    for m in re.finditer(r"[A-Za-z_]\w*(?:\s*%\s*[A-Za-z_]\w*)*", text or ""):
        p = re.sub(r"\s*%\s*", "%", m.group(0)).lower()
        if p not in out:
            out.append(p)
    return out
