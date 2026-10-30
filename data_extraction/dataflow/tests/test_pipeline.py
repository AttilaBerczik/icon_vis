"""Unit and end-to-end tests for the data-flow extractor."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from dataclasses import asdict

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)

from dataflow import interproc, intraproc, linker, execspace  # noqa: E402
from dataflow.directives import scan_directives  # noqa: E402
from dataflow.frontends.masking import mask_source  # noqa: E402
from dataflow.linemap import build_line_map  # noqa: E402
from dataflow.paths import PathResolver  # noqa: E402
from dataflow.profile import load_profile  # noqa: E402
from dataflow.symtab import SymbolTable, merge_profile_facts  # noqa: E402
from dataflow.worker import process_file  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures")


def run_file(path: str, profile_name: str = "cpu-gcc") -> dict:
    prof = asdict(load_profile(profile_name))
    with tempfile.TemporaryDirectory() as cache:
        res = process_file({
            "path": path,
            "rel_path": os.path.basename(path),
            "component": "test",
            "is_test": True,
            "lang": "fortran" if path.endswith(".f90") else "cpp",
            "model_root": None,
            "include_dirs": [],
            "cache_dir": cache,
            "cache": False,
            "profile": prof,
        })
    return merge_profile_facts([res["facts"]])


class LinemapTests(unittest.TestCase):
    def test_markers_and_include_locations(self):
        raw = (
            '# 1 "a.f90"\n'
            "program a\n"
            '# 1 "b.inc"\n'
            "integer :: x\n"
            '# 2 "a.f90"\n'
            "end program a\n"
        )
        text, lm = build_line_map(raw, "a.f90")
        self.assertEqual(text.splitlines()[0], "program a")
        self.assertEqual(lm.get(1), ("a.f90", 1))
        self.assertEqual(lm.get(2), ("b.inc", 1))
        self.assertEqual(lm.get(3), ("a.f90", 2))


class FparserLineMapTests(unittest.TestCase):
    def test_facts_use_original_source_lines(self):
        # Simulate cpp inserting an include: clean text line numbers no longer
        # match the original file after the include.
        from dataflow.frontends import fortran_fparser
        raw = (
            '# 1 "orig.f90"\n'
            "module m\n"
            "  use iso_c_binding\n"
            '# 1 "inc.inc"\n'
            + "! include padding\n" * 10 +
            '# 4 "orig.f90"\n'
            "contains\n"
            "subroutine s(a)\n"
            "  integer, intent(in) :: a\n"
            "  integer :: x\n"
            "  x = a\n"
            "end subroutine s\n"
            "end module m\n"
        )
        text, lm = build_line_map(raw, "orig.f90")
        facts = fortran_fparser.parse("orig.f90", "orig.f90", text, lm, "cpu-gcc")
        proc = facts["procedures"][0]
        self.assertEqual(facts["modules"][0]["line"], 1)
        self.assertEqual(facts["modules"][0]["uses"][0]["line"], 2)
        self.assertEqual(proc["line"], 5)
        self.assertEqual(proc["end_line"], 9)
        self.assertEqual(proc["params"][0]["line"], 6)
        self.assertEqual(proc["decls"][1]["line"], 7)
        self.assertEqual(proc["stmts"][0]["line"], 8)


class PathTests(unittest.TestCase):
    def test_subscripts_on_every_component(self):
        from dataflow.facts import normalize_path, scan_paths
        self.assertEqual(normalize_path("p_nh_state(jg)%prog(ntl)%w(jc,jk,jb)"),
                         "p_nh_state%prog%w")
        paths = scan_paths("p(icidx(je,jb,1))%x = q%y + f(z)")
        self.assertIn("p%x", paths)
        self.assertIn("q%y", paths)
        self.assertIn("icidx", paths)
        self.assertIn("z", paths)


class DirectiveTests(unittest.TestCase):
    def test_acc_parallel_with_continuation(self):
        text = (
            "!$ACC PARALLEL LOOP IF(lacc) PRESENT(p_patch) &\n"
            "!$ACC& PRIVATE(jc, jk) COPYIN(p_nh%prog)\n"
        )
        _, lm = build_line_map(text, "x.f90")
        dirs = scan_directives(text, lm)
        self.assertEqual(len(dirs), 1)
        d = dirs[0]
        self.assertEqual(d["kind"], "acc")
        self.assertEqual(d["directive"], "PARALLEL")
        clauses = {c["clause"]: c for c in d["clauses"]}
        self.assertIn("PRESENT", clauses)
        self.assertEqual(clauses["PRESENT"]["vars"], ["p_patch"])
        self.assertEqual(clauses["COPYIN"]["vars"], ["p_nh%prog"])
        self.assertEqual(clauses["PRIVATE"]["vars"], ["jc", "jk"])

    def test_wait_clause_does_not_break_directive(self):
        text = "!$ACC WAIT(1)\n!$ACC UPDATE DEVICE(p_patch%cells)\n"
        _, lm = build_line_map(text, "x.f90")
        dirs = scan_directives(text, lm)
        self.assertEqual(dirs[0]["directive"], "WAIT")
        self.assertEqual(dirs[1]["directive"], "UPDATE")


class MaskingTests(unittest.TestCase):
    def test_length_preserving(self):
        src = "KOKKOS_LAMBDA KOKKOS_INLINE_FUNCTION __global__\n"
        masked, markers = mask_source(src)
        self.assertEqual(len(masked), len(src))
        self.assertEqual(src.count("\n"), masked.count("\n"))
        self.assertEqual(len(markers), 3)


class FortranPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facts = run_file(os.path.join(FIXTURES, "fixture.f90"))
        cls.sym = SymbolTable([cls.facts])
        cls.direct = {
            pid: intraproc.analyse_proc(cls.sym, proc)
            for pid, proc in cls.sym.procs.items()
        }
        cls.link = linker.link(cls.sym)
        cls.inter = interproc.propagate(cls.sym, cls.link, cls.direct)
        cls.exec_info = execspace.apply(cls.sym, [cls.facts], cls.inter.accesses)

    def test_module_and_types(self):
        self.assertEqual(self.facts["tier"], "fparser")
        self.assertIn("fixture_mod", self.sym.modules)
        self.assertIn("t_state", self.sym.types)
        fields = {f["name"] for f in self.sym.types["t_state"][0]["fields"]}
        self.assertEqual(fields, {"field", "other"})

    def test_field_entity_and_intent(self):
        writer = self.inter.accesses["fixture_mod::writer"]
        writes = [a for a in writer if a["mode"] == "write"]
        self.assertTrue(any(a["entity"] == "field:t_state%field" for a in writes))
        reader = self.inter.accesses["fixture_mod::reader"]
        self.assertTrue(any(a["entity"] == "field:t_state%field" and a["mode"] == "read"
                            for a in reader))

    def test_interprocedural_mapping(self):
        caller = self.inter.accesses["fixture_mod::caller"]
        modes = {a["mode"] for a in caller if a["entity"] == "field:t_state%field"}
        self.assertIn("write", modes)
        self.assertIn("read", modes)
        self.assertTrue(any(p["caller"] == "fixture_mod::caller" for p in self.inter.passes))

    def test_calls_and_exec_space(self):
        self.assertIn("fixture_mod::writer", [c.callee for c in self.link.calls["fixture_mod::caller"]])
        self.assertEqual(self.exec_info["exec_by_proc"]["fixture_mod::writer"], "device")
        self.assertEqual(self.exec_info["exec_by_proc"]["fixture_mod::reader"], "host")

    def test_may_alias(self):
        tiny = run_file(os.path.join(FIXTURES, "fixture.f90"))
        # Add an alias statement as the parser would produce it.
        proc = next(p for p in tiny["procedures"] if p["name"] == "caller")
        proc["aliases"].append({"left": "p", "right": "state%field", "line": 1})
        proc["decls"].append({"name": "p", "type": "real(kind=wp)", "rank": 1,
                              "attrs": [], "intent": None})
        sym = SymbolTable([tiny])
        proc = next(p for p in sym.procs.values() if p["name"] == "caller")
        rp = PathResolver(sym, proc).resolve("p", "fixture_mod::caller")
        self.assertEqual(rp.path, "state%field")


class CppPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facts = run_file(os.path.join(FIXTURES, "fixture.cpp"))
        cls.sym = SymbolTable([cls.facts])
        cls.direct = {pid: intraproc.analyse_proc(cls.sym, p)
                      for pid, p in cls.sym.procs.items()}

    def test_struct_fields(self):
        self.assertIn("state", self.sym.types)
        self.assertEqual({f["name"] for f in self.sym.types["state"][0]["fields"]},
                         {"field", "n"})

    def test_reads_writes_and_lambda(self):
        read = next(pid for pid, p in self.sym.procs.items() if p["name"] == "read_state")
        write = next(pid for pid, p in self.sym.procs.items() if p["name"] == "write_state")
        self.assertTrue(any(a["mode"] == "read" for a in self.direct[read]))
        self.assertTrue(any(a["mode"] == "write" for a in self.direct[write]))
        kernel = next(pid for pid, p in self.sym.procs.items() if p["name"] == "kernel")
        self.assertTrue(any(a["entity"] == "field:state%field" for a in self.direct[kernel]))


if __name__ == "__main__":
    unittest.main()
