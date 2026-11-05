"""Unit tests for the static viewer export (field merge, groups, origins)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)

from dataflow.export import vis  # noqa: E402


TYPES = vis.TypesView([
    {"name": "t_prog", "fields": [
        {"name": "rho", "type": "real(kind=wp)"},
        {"name": "vn", "type": "real(kind=wp)"},
        {"name": "w", "type": "real(kind=wp)"},
        {"name": "exner", "type": "real(kind=wp)"},
        {"name": "theta_v", "type": "real(kind=wp)"},
    ]},
    {"name": "t_nh_state", "fields": [
        {"name": "prog", "type": "t_prog"},
        {"name": "diag", "type": "t_diag"},
    ]},
    {"name": "t_diag", "fields": [
        {"name": "airmass", "type": "real(kind=wp)"},
    ]},
    {"name": "t_patch", "fields": [
        {"name": "cells", "type": "t_patch_cells"},
    ]},
    {"name": "t_patch_cells", "fields": [
        {"name": "start_index", "type": "integer"},
        {"name": "end_index", "type": "integer"},
        {"name": "start_block", "type": "integer"},
        {"name": "end_block", "type": "integer"},
        {"name": "owned", "type": "logical", "pointer": True},
    ]},
])


def make_source() -> dict:
    functions = {
        "program::main": {
            "id": "program::main", "name": "main", "module": None,
            "kind": "program", "lang": "fortran", "file": "/m/src/drivers/main.f90",
            "line": 1, "end_line": 30, "params": [], "result": None,
            "exec_space": "host", "aliases": [],
        },
        "mod_a::f": {
            "id": "mod_a::f", "name": "f", "module": "mod_a", "kind": "subroutine",
            "lang": "fortran", "file": "/m/src/a/mod_a.f90", "line": 10, "end_line": 20,
            "params": [{"name": "rho", "type": "real(kind=wp)", "rank": 0,
                        "intent": "inout", "inferred_intent": "inout"}],
            "result": None, "exec_space": "host", "aliases": [],
        },
        "mod_b::g": {
            "id": "mod_b::g", "name": "g", "module": "mod_b", "kind": "subroutine",
            "lang": "fortran", "file": "/m/src/b/mod_b.f90", "line": 10, "end_line": 20,
            "params": [{"name": "rho", "type": "real(kind=wp)", "rank": 0,
                        "intent": "in", "inferred_intent": "in"}],
            "result": None, "exec_space": "host", "aliases": [],
        },
        "mod_c::h": {
            "id": "mod_c::h", "name": "h", "module": "mod_c", "kind": "subroutine",
            "lang": "fortran", "file": "/m/src/c/mod_c.f90", "line": 10, "end_line": 20,
            "params": [{"name": "rho", "type": "real(kind=wp)", "rank": 0,
                        "intent": "out", "inferred_intent": "out"}],
            "result": None, "exec_space": "host", "aliases": [],
        },
        "util::finish": {
            "id": "util::finish", "name": "finish", "module": "util", "kind": "subroutine",
            "lang": "fortran", "file": "/m/src/util/util.f90", "line": 10, "end_line": 20,
            "params": [{"name": "msg", "type": "character", "rank": 0,
                        "intent": "in", "inferred_intent": "in"}],
            "result": None, "exec_space": "host", "aliases": [],
        },
    }
    calls = [
        {"caller": "program::main", "callee": "mod_a::f", "line": 10, "weight": 1,
         "kind": "call", "virtual": False},
        {"caller": "program::main", "callee": "mod_b::g", "line": 20, "weight": 1,
         "kind": "call", "virtual": False},
        {"caller": "program::main", "callee": "mod_c::h", "line": 30, "weight": 1,
         "kind": "call", "virtual": False},
        {"caller": "mod_c::h", "callee": "util::finish", "line": 12, "weight": 1,
         "kind": "call", "virtual": False},
        {"caller": "mod_a::f", "callee": "util::finish", "line": 12, "weight": 1,
         "kind": "call", "virtual": False},
    ]
    accesses = [
        {"proc": "mod_c::h", "entity": "field:t_nh_state%prog%rho", "mode": "write",
         "line": 12, "via": "assign", "root": "prog", "root_kind": "param", "scope": "mod_c"},
        {"proc": "mod_a::f", "entity": "field:t_nh_state%prog%rho", "mode": "readwrite",
         "line": 15, "via": "assign", "root": "rho", "root_kind": "param", "scope": "mod_a"},
        {"proc": "mod_b::g", "entity": "field:t_nh_state%prog%rho", "mode": "read",
         "line": 14, "via": "expr", "root": "rho", "root_kind": "param", "scope": "mod_b"},
        {"proc": "mod_a::f", "entity": "local:mod_a::f::msg", "mode": "write",
         "line": 16, "via": "assign", "root": "msg", "root_kind": "local", "scope": "mod_a"},
        {"proc": "mod_c::h", "entity": "local:mod_c::h::msg", "mode": "write",
         "line": 16, "via": "assign", "root": "msg", "root_kind": "local", "scope": "mod_c"},
    ]
    passes = [
        {"caller": "program::main", "callee": "mod_a::f", "line": 10,
         "formal": "param:mod_a::f::rho", "actual": "field:t_nh_state%prog%rho", "mode": "readwrite"},
        {"caller": "program::main", "callee": "mod_b::g", "line": 20,
         "formal": "param:mod_b::g::rho", "actual": "field:t_nh_state%prog%rho", "mode": "read"},
        {"caller": "program::main", "callee": "mod_c::h", "line": 30,
         "formal": "param:mod_c::h::rho", "actual": "field:t_nh_state%prog%rho", "mode": "write"},
        # Two unrelated locals into the same formal: must NOT be merged.
        {"caller": "mod_a::f", "callee": "util::finish", "line": 12,
         "formal": "param:util::finish::msg", "actual": "local:mod_a::f::msg", "mode": "read"},
        {"caller": "mod_c::h", "callee": "util::finish", "line": 12,
         "formal": "param:util::finish::msg", "actual": "local:mod_c::h::msg", "mode": "read"},
    ]
    file_meta = {
        "/m/src/drivers/main.f90": {"rel_path": "src/drivers/main.f90", "component": "drivers"},
        "/m/src/a/mod_a.f90": {"rel_path": "src/a/mod_a.f90", "component": "a"},
        "/m/src/b/mod_b.f90": {"rel_path": "src/b/mod_b.f90", "component": "b"},
        "/m/src/c/mod_c.f90": {"rel_path": "src/c/mod_c.f90", "component": "c"},
        "/m/src/util/util.f90": {"rel_path": "src/util/util.f90", "component": "util"},
    }
    return {
        "functions": functions,
        "calls": calls,
        "accesses": accesses,
        "passes": passes,
        "types": TYPES,
        "model_root": "/m",
        "file_meta": file_meta,
    }


class FieldMergeTests(unittest.TestCase):
    def test_nested_path_merges_onto_leaf_owner(self):
        self.assertEqual(
            vis.canonical_field_entity("field:t_nh_state%prog%rho", TYPES),
            "field:t_prog%rho",
        )
        self.assertEqual(
            vis.canonical_field_entity("field:t_patch%cells%start_index", TYPES),
            "field:t_patch_cells%start_index",
        )

    def test_unknown_path_is_unchanged(self):
        self.assertEqual(
            vis.canonical_field_entity("field:not_a_real_type%x", TYPES),
            "field:not_a_real_type%x",
        )


class ShardNameTests(unittest.TestCase):
    def test_safe_name_drops_dots(self):
        # "." / ".." are real component names for sources outside the model
        # root; shard paths must never contain "..".
        for value in (".", "..", "...", "a..b", "a.b"):
            name = vis._safe_name(value)
            self.assertNotIn(".", name)
            self.assertTrue(name)
        self.assertEqual(vis._safe_name("atm_phy_schemes"), "atm_phy_schemes")

    def test_shard_names_are_secure_and_unique(self):
        src = make_source()
        meta = dict(src["file_meta"])
        meta["/m/src/a/mod_a.f90"] = {"rel_path": "src/a/mod_a.f90", "component": ".."}
        meta["/m/src/b/mod_b.f90"] = {"rel_path": "src/b/mod_b.f90", "component": "."}
        graph = vis.build_graph(src["functions"], src["calls"], meta, "/m")
        shards = graph["fnShards"]
        self.assertEqual(len(shards), len(set(shards)))
        for shard in shards:
            self.assertNotIn("..", shard)
            self.assertEqual(shard.count("."), 1)
            self.assertTrue(shard.startswith("fn/") and shard.endswith(".json"))


class ParameterPathTests(unittest.TestCase):
    def test_synthetic_owner_step_is_not_a_path(self):
        self.assertFalse(vis._has_trace_path(None))
        self.assertFalse(vis._has_trace_path([]))
        self.assertFalse(vis._has_trace_path([[1, 0, 6, 0, -1, "/m/f.f90"]]))
        self.assertTrue(vis._has_trace_path([[1, 12, 6, 0, -1, "/m/f.f90"]]))
        self.assertTrue(vis._has_trace_path([
            [1, 0, 6, 0, 2, "/m/f.f90"],
            [2, 0, 6, 0, -1, "/m/f.f90"],
        ]))

    def test_parameter_without_events_is_marked_no_path(self):
        src = make_source()
        # Remove every binding for g::rho so the only remaining step is the
        # synthetic owner step emitted by _build_backward.
        src["passes"] = [p for p in src["passes"]
                         if p["formal"] != "param:mod_b::g::rho"]
        src["accesses"] = [a for a in src["accesses"]
                           if a["entity"] != "param:mod_b::g::rho"]
        graph = vis.build_graph(
            src["functions"], src["calls"], src["file_meta"], "/m"
        )
        trace = vis.build_traces(src, graph)
        with tempfile.TemporaryDirectory() as tmp:
            vis.build_function_shards(src, graph, trace, tmp)
            functions = {}
            for shard in graph["fnShards"]:
                with open(os.path.join(tmp, shard), encoding="utf-8") as fh:
                    functions.update(json.load(fh)["functions"])

        no_path = {p["n"]: p for p in functions["mod_b::g"]["params"]}
        self.assertEqual(no_path["rho"].get("np"), 1)
        self.assertNotIn("src", no_path["rho"])

        # a::f::rho is passed in from main, so it keeps a usable path.
        with_path = {p["n"]: p for p in functions["mod_a::f"]["params"]}
        self.assertNotIn("np", with_path["rho"])


class StaticOrderTests(unittest.TestCase):
    def test_call_site_line_order(self):
        src = make_source()
        order = vis.compute_static_order("program::main", src["calls"], src["functions"])
        self.assertEqual(order["program::main"], 0)
        self.assertLess(order["mod_a::f"], order["mod_b::g"])
        self.assertLess(order["mod_a::f"], order["mod_c::h"])


class TraceGroupTests(unittest.TestCase):
    def setUp(self):
        self.src = make_source()
        self.graph = vis.build_graph(
            self.src["functions"], self.src["calls"], self.src["file_meta"], "/m"
        )
        self.trace = vis.build_traces(self.src, self.graph)

    def test_graph_reachability(self):
        self.assertEqual(self.graph["rootId"], "program::main")
        self.assertEqual(self.graph["functionCount"], 5)
        self.assertEqual(len(self.graph["edges"]), 5)

    def test_field_aliases_form_one_group(self):
        a = self.trace.group_of[
            vis.canonical_field_entity("field:t_nh_state%prog%rho", TYPES)
        ]
        b = self.trace.group_of["field:t_prog%rho"]
        self.assertEqual(a, b)
        rec = self.trace.groups[a]
        self.assertIn("param:mod_a::f::rho", rec["entities"])
        self.assertIn("param:mod_b::g::rho", rec["entities"])
        self.assertIn("param:mod_c::h::rho", rec["entities"])

    def test_ambiguous_formal_does_not_merge_actuals(self):
        a = self.trace.group_of["local:mod_a::f::msg"]
        b = self.trace.group_of["local:mod_c::h::msg"]
        self.assertNotEqual(a, b)

    def test_origin_prefers_pure_write(self):
        gid = self.trace.group_of["field:t_prog%rho"]
        origin = self.trace.groups[gid]["origin"]
        # mod_c::h has a pure write; mod_a::f only a read-modify-write.
        self.assertEqual(origin["name"], "h")
        self.assertEqual(origin["line"], 12)

    def test_backward_chain_ends_at_caller_that_writes(self):
        gid = self.trace.group_of["field:t_prog%rho"]
        chain = self.trace.groups[gid]["backward"]["param:mod_a::f::rho"]
        fns = [step[0] for step in chain]
        self.assertGreaterEqual(len(fns), 2)
        self.assertEqual(self.graph["ids"][fns[0]], "mod_a::f")
        self.assertEqual(self.graph["ids"][fns[-1]], "mod_c::h")
        self.assertTrue(all(len(step) >= 5 for step in chain))

    def test_search_index_contains_field_and_parameter(self):
        names = {row[0] for row in self.trace.search}
        self.assertIn("t_prog%rho", names)
        self.assertIn("rho", names)




STRUCT_TYPES = vis.TypesView([
    {"name": "t_coord", "module": "m_geom", "file": "/m/src/geom.f90", "line": 10,
     "fields": [
         {"name": "x", "type": "real(kind=wp)"},
         {"name": "y", "type": "real(kind=wp)"},
     ]},
    {"name": "t_cell", "module": "m_geom", "file": "/m/src/geom.f90", "line": 30,
     "fields": [
         {"name": "center", "type": "t_coord", "rank": 0},
         {"name": "area", "type": "real(kind=wp)", "rank": 2},
         {"name": "idx", "type": "integer", "rank": 1, "allocatable": True},
         {"name": "flags", "type": "logical", "rank": 0},
         {"name": "tag", "type": "integer", "rank": 0},
     ]},
    {"name": "t_holder", "module": "m_geom", "file": "/m/src/geom.f90", "line": 50,
     "fields": [
         {"name": "target", "type": "t_cell", "rank": 0, "pointer": True},
         {"name": "next", "type": "t_holder", "rank": 0, "pointer": True},
         {"name": "count", "type": "integer", "rank": 0},
     ]},
    {"name": "t_base", "module": "m_geom", "file": "/m/src/geom.f90", "line": 70,
     "fields": [
         {"name": "base_val", "type": "real(kind=wp)"},
         {"name": "shared", "type": "t_cell"},
         {"name": "a", "type": "integer"}, {"name": "b", "type": "integer"},
         {"name": "c", "type": "integer"},
     ]},
    {"name": "t_child", "module": "m_geom", "file": "/m/src/geom.f90", "line": 90,
     "extends": "t_base", "fields": [
         {"name": "child_val", "type": "real(kind=wp)"},
     ]},
    {"name": "t_patch", "module": "m_geom", "file": "/m/src/geom.f90", "line": 110,
     "fields": [
         {"name": "cells", "type": "t_cell", "rank": 2},
         {"name": "holder", "type": "t_holder", "rank": 0},
     ]},
])


def make_struct_source() -> dict:
    functions = {
        "program::main": {
            "id": "program::main", "name": "main", "module": None,
            "kind": "program", "lang": "fortran", "file": "/m/src/main.f90",
            "line": 1, "end_line": 30, "params": [], "result": None,
            "exec_space": "host", "aliases": [],
        },
        "m_use::work": {
            "id": "m_use::work", "name": "work", "module": "m_use",
            "kind": "subroutine", "lang": "fortran", "file": "/m/src/use.f90",
            "line": 10, "end_line": 30,
            "params": [
                {"name": "p_patch", "type": "t_patch", "rank": 0,
                 "intent": "inout", "inferred_intent": "inout"},
                {"name": "cell", "type": "t_cell", "rank": 0,
                 "intent": "inout", "inferred_intent": "inout"},
            ],
            "result": None, "exec_space": "host", "aliases": [],
        },
    }
    calls = [{"caller": "program::main", "callee": "m_use::work", "line": 5,
              "weight": 1, "kind": "call", "virtual": False}]
    accesses = [
        {"proc": "m_use::work", "entity": "field:t_patch%cells%center%x",
         "mode": "read", "line": 12, "via": "expr", "root": "p_patch",
         "root_kind": "param", "scope": "m_use", "type": "t_patch"},
        {"proc": "m_use::work", "entity": "field:t_cell%center%y",
         "mode": "read", "line": 13, "via": "expr", "root": "cell",
         "root_kind": "param", "scope": "m_use", "type": "t_cell"},
        {"proc": "m_use::work", "entity": "field:t_patch%holder%target%area",
         "mode": "write", "line": 14, "via": "assign", "root": "p_patch",
         "root_kind": "param", "scope": "m_use", "type": "t_patch"},
        {"proc": "m_use::work", "entity": "field:t_child%base_val",
         "mode": "read", "line": 16, "via": "expr", "root": "c",
         "root_kind": "local", "scope": "m_use", "type": "t_child"},
        {"proc": "m_use::work", "entity": "field:t_nowhere%leaf",
         "mode": "read", "line": 18, "via": "expr", "root": "u",
         "root_kind": "local", "scope": "m_use", "type": None},
        {"proc": "m_use::work", "entity": "field:t_nowhere%leaf%deeper",
         "mode": "read", "line": 19, "via": "expr", "root": "u",
         "root_kind": "local", "scope": "m_use", "type": None},
        {"proc": "m_use::work", "entity": "param:m_use::work::cell",
         "mode": "write", "line": 20, "via": "assign", "root": "cell",
         "root_kind": "param", "scope": "m_use", "type": "t_cell"},
    ]
    passes = [
        # Struct formal + field actual: must NOT be merged into the member.
        {"caller": "program::main", "callee": "m_use::work", "line": 5,
         "formal": "param:m_use::work::p_patch",
         "actual": "field:t_patch%cells%area", "mode": "read"},
        # Struct formal + same-type holder actual: same type, may merge.
        {"caller": "program::main", "callee": "m_use::work", "line": 5,
         "formal": "param:m_use::work::cell",
         "actual": "var:m_geom::cell_module", "mode": "write"},
    ]
    variables = [
        {"id": "var:m_geom::cell_module", "kind": "var",
         "name": "cell_module", "scope": "m_geom", "module": "m_geom",
         "type": "t_cell", "rank": 0, "line": 3, "file": "/m/src/geom.f90",
         "flags": 0},
    ]
    file_meta = {
        "/m/src/main.f90": {"rel_path": "src/main.f90", "component": "main"},
        "/m/src/use.f90": {"rel_path": "src/use.f90", "component": "use"},
        "/m/src/geom.f90": {"rel_path": "src/geom.f90", "component": "geom"},
    }
    return {
        "functions": functions, "calls": calls, "accesses": accesses,
        "passes": passes, "types": STRUCT_TYPES, "variables": variables,
        "entity_types": {"var:m_geom::cell_module": "t_cell"},
        "model_root": "/m", "file_meta": file_meta,
    }


class StructModelTests(unittest.TestCase):
    def setUp(self):
        self.src = make_struct_source()
        self.graph = vis.build_graph(
            self.src["functions"], self.src["calls"], self.src["file_meta"], "/m")
        self.trace = vis.build_traces(self.src, self.graph)
        self.registry = self.trace.registry

    def test_value_type_is_detected(self):
        self.assertTrue(self.registry.is_value("t_coord"))
        self.assertFalse(self.registry.is_value("t_cell"))
        self.assertFalse(self.registry.is_value("t_base"))

    def test_nested_and_pointer_routes(self):
        res = self.registry.resolve("field:t_patch%cells%center%x")
        self.assertEqual(res.member, "t_cell%center")
        self.assertEqual(res.route, "t_patch%cells%center%x")
        self.assertEqual(res.subcomponent, "x")
        self.assertIn("t_cell", res.owner_chain)
        pointer = self.registry.resolve("field:t_patch%holder%target%area")
        self.assertEqual(pointer.member, "t_cell%area")
        self.assertFalse(pointer.unresolved)

    def test_inherited_member_resolves_to_base(self):
        res = self.registry.resolve("field:t_child%base_val")
        self.assertEqual(res.member, "t_base%base_val")
        self.assertIn("t_base", res.owner_chain)
        fields = self.registry.fields_with_owner("t_child")
        inherited = {f["name"]: f for f in fields if f.get("inheritedFrom")}
        self.assertIn("base_val", inherited)
        self.assertEqual(inherited["base_val"]["declaring"], "t_base")

    def test_value_tail_creates_one_member_group(self):
        route = "field:t_patch%cells%center%x"
        member = "field:t_cell%center"
        self.assertEqual(self.trace.group_of[route], self.trace.group_of[member])
        rec = self.trace.groups[self.trace.group_of[member]]
        self.assertEqual(rec["member"], "t_cell%center")
        # The value tail is a route/facet, never a member identity of its own.
        self.assertIn("field:t_cell%center%y", rec["entities"])
        routes = {r[0] for r in rec["routes"]}
        self.assertIn("t_patch%cells%center%x", routes)
        self.assertIn("t_cell%center%y", routes)

    def test_unresolved_routes_are_kept_verbatim(self):
        res = self.registry.resolve("field:t_nowhere%leaf")
        self.assertTrue(res.unresolved)
        self.assertIsNone(res.member)
        self.assertEqual(res.route, "t_nowhere%leaf")
        self.assertIn("field:t_nowhere%leaf", self.trace.group_of)

    def test_struct_formal_is_not_absorbed_into_field_group(self):
        formal = "param:m_use::work::p_patch"
        member = "field:t_cell%area"
        self.assertNotEqual(self.trace.group_of[formal], self.trace.group_of[member])
        self.assertNotIn(formal, self.trace.groups[self.trace.group_of[member]]["entities"])

    def test_struct_formal_unions_with_same_type_holder(self):
        formal = "param:m_use::work::cell"
        holder = "var:m_geom::cell_module"
        self.assertEqual(self.trace.group_of[formal], self.trace.group_of[holder])

    def test_search_rows_carry_type_and_member(self):
        rows = [r for r in self.trace.search if r[0] == "t_cell%area"]
        self.assertTrue(rows)
        self.assertEqual(rows[0][5], "t_cell")
        self.assertEqual(rows[0][6], "t_cell%area")
        self.assertTrue(any(r[0] == "t_cell" and r[2] == 3 for r in self.trace.search))

    def test_struct_payload_containment_holders_and_cycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = vis.build_structs(self.src, self.trace, self.graph, tmp)
            with open(os.path.join(tmp, "structs.json"), encoding="utf-8") as fh:
                data = json.load(fh)
            types = data["types"]
            self.assertIn("t_cell", types)
            parents = {tuple(p) for p in types["t_cell"]["parents"]}
            self.assertIn(("t_patch", "cells"), parents)
            self.assertIn(("t_holder", "target"), parents)
            # A struct member without its own group still shows the routes of
            # its nested members.
            patch_routes = types["t_patch"]["routes"]["t_patch%cells"]
            self.assertIn("t_patch%cells%center%x", {r[0] for r in patch_routes})
            holder_ids = {h["id"] for h in types["t_cell"]["holders"]}
            self.assertIn("var:m_geom::cell_module", holder_ids)
            # Recursive t_holder -> t_holder rollup must terminate.
            self.assertIn("t_holder", types)
            self.assertTrue(summary["types"] >= 6)
            # Touch shard for t_cell exists and contains member touch sets.
            shard = types["t_cell"]["shard"]
            with open(os.path.join(tmp, shard), encoding="utf-8") as fh:
                touch = json.load(fh)["types"]["t_cell"]
            self.assertIn("t_cell%area", touch["members"])

    def test_duplicate_type_names_share_component_lookup(self):
        types = vis.TypesView([
            {"name": "t_dup", "module": "m_a", "fields": [
                {"name": "only_a", "type": "integer"},
            ]},
            {"name": "t_dup", "module": "m_b", "fields": [
                {"name": "only_b", "type": "integer"},
                {"name": "ptr", "type": "t_child"},
            ]},
            {"name": "t_child", "module": "m_b", "fields": [
                {"name": "value", "type": "real(kind=wp)"},
                {"name": "a", "type": "integer"}, {"name": "b", "type": "integer"},
                {"name": "c", "type": "integer"}, {"name": "d", "type": "integer"},
            ]},
        ])
        registry = vis.TypeRegistry(types)
        res = registry.resolve("field:t_dup%only_b")
        self.assertEqual(res.member, "t_dup%only_b")
        self.assertFalse(res.unresolved)
        # The second declaration is chosen as the canonical page because it
        # has the merged component set.
        self.assertEqual(registry.get("t_dup")["module"], "m_b")

    def test_polymorphic_component_resolves_through_unique_subtype(self):
        types = vis.TypesView([
            {"name": "t_base", "module": "m", "extends": None, "fields": [
                {"name": "descr", "type": "integer"},
            ]},
            {"name": "t_impl", "module": "m", "extends": "t_base", "fields": [
                {"name": "n_pnts", "type": "integer"},
                {"name": "a", "type": "integer"}, {"name": "b", "type": "integer"},
                {"name": "c", "type": "integer"}, {"name": "d", "type": "integer"},
            ]},
        ])
        registry = vis.TypeRegistry(types)
        res = registry.resolve("field:t_base%n_pnts")
        self.assertEqual(res.member, "t_impl%n_pnts")
        self.assertFalse(res.unresolved)
        # An ambiguous component (declared by several subtypes) stays raw.
        types2 = vis.TypesView([
            {"name": "t_base", "fields": []},
            {"name": "t_a", "extends": "t_base", "fields": [{"name": "x", "type": "integer"}]},
            {"name": "t_b", "extends": "t_base", "fields": [{"name": "x", "type": "integer"}]},
        ])
        registry2 = vis.TypeRegistry(types2)
        self.assertTrue(registry2.resolve("field:t_base%x").unresolved)

    def test_routes_have_counts(self):
        gid = self.trace.group_of["field:t_cell%area"]
        routes = {r[0]: r for r in self.trace.groups[gid]["routes"]}
        route = routes["t_patch%holder%target%area"]
        self.assertEqual(route[1], 0)
        # The first pure write to a field is promoted to its creation point.
        self.assertEqual(route[2] + route[3], 1)
        self.assertGreaterEqual(route[4], 1)


if __name__ == "__main__":
    unittest.main()
