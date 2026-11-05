"""Scripted assertions for the reference cases in the struct-explorer plan.

These run against the generated ``vis/`` tree. When it has not been built the
class is skipped, so the unit-test suite still works in a clean checkout.
"""

from __future__ import annotations

import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(PKG))
VIS = os.path.join(REPO, "vis")
STRUCTS = os.path.join(VIS, "structs.json")


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _trace(gid):
    shard = os.path.join(VIS, "trace", f"{gid[:2]}.json")
    return _load(shard)["groups"][gid]


@unittest.skipUnless(os.path.isfile(STRUCTS), "vis/structs.json not built")
class ReferenceCaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = _load(STRUCTS)["types"]

    def field(self, type_key, name):
        return next(f for f in self.data[type_key]["fields"] if f["name"] == name)

    def test_cartesian_center_is_one_member_with_all_routes(self):
        field = self.field("t_grid_cells", "cartesian_center")
        self.assertEqual(field["member"], "t_grid_cells%cartesian_center")
        self.assertTrue(field["value"])
        routes = {r[0] for r in self.data["t_grid_cells"]["routes"][field["member"]]}
        self.assertIn("t_patch%cells%cartesian_center", routes)
        self.assertIn("t_patch%cells%cartesian_center%x", routes)
        self.assertTrue(any(r.startswith("t_patch_3d%p_patch_2d%cells%cartesian_center")
                            for r in routes))
        self.assertTrue(any(r.startswith("p_t_patch%p%cells%cartesian_center")
                            for r in routes))
        self.assertIn("t_grid_cells%cartesian_center", routes)
        trace = _trace(field["gid"])
        self.assertEqual(trace["origin"]["line"], 319)
        self.assertIn("mo_alloc_patches.f90", trace["origin"]["file"])
        # The value-type tail is a route, not a member of its own.
        self.assertFalse(any(f["name"] == "x" for f in self.data["t_grid_cells"]["fields"]))

    def test_edges_cartesian_center_stays_separate(self):
        self.assertEqual(
            self.field("t_grid_edges", "cartesian_center")["member"],
            "t_grid_edges%cartesian_center")
        self.assertNotEqual(
            self.field("t_grid_edges", "cartesian_center")["gid"],
            self.field("t_grid_cells", "cartesian_center")["gid"])

    def test_patch_holders_and_parents(self):
        rec = self.data["t_patch"]
        holder_names = {h["name"] for h in rec["holders"]}
        self.assertIn("p_patch", holder_names)
        parents = {tuple(p) for p in rec["parents"]}
        self.assertIn(("p_t_patch", "p"), parents)
        self.assertIn(("t_patch_3d", "p_patch_2d"), parents)

    def test_nh_prog_reached_through_nh_state(self):
        field = self.field("t_nh_prog", "vn")
        routes = {r[0] for r in self.data["t_nh_prog"]["routes"][field["member"]]}
        self.assertIn("t_nh_state%prog%vn", routes)
        rho = self.field("t_nh_prog", "rho")
        routes = {r[0] for r in self.data["t_nh_prog"]["routes"][rho["member"]]}
        self.assertIn("t_nh_state%prog%rho", routes)

    def test_area_group_has_no_patch_parameters(self):
        area = self.field("t_grid_cells", "area")
        trace = _trace(area["gid"])
        params = [e for e in trace["entities"] if e.startswith("param:")]
        self.assertFalse([p for p in params if p.endswith("::p_patch")])
        self.assertEqual(trace["member"], "t_grid_cells%area")

    def test_every_member_has_declaration_info(self):
        missing = [key for key, rec in self.data.items()
                   if rec["fields"] and (not rec["file"] or not rec["line"])]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
