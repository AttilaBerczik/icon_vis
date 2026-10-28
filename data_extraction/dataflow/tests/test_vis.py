"""Unit tests for the static viewer export (field merge, groups, origins)."""

from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)

from dataflow.export import vis  # noqa: E402


TYPES = vis.TypesView([
    {"name": "t_prog", "fields": [
        {"name": "rho", "type": "real(kind=wp)"},
        {"name": "vn", "type": "real(kind=wp)"},
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


if __name__ == "__main__":
    unittest.main()
