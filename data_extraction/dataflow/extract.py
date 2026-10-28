#!/usr/bin/env python3
"""ICON data-flow extraction CLI.

Example
-------
    python data_extraction/dataflow/extract.py \
        --root /home/attila/experiment/icon-model \
        --extra-root data_extraction/libiconmath-main \
        --profile cpu-gcc,gpu-nvhpc --jobs 8 --out data_extraction/out
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict

from dataflow import execspace, interproc, intraproc, linker as linker_mod, residency
from dataflow.export import coverage, dot, entities, index, shards, sqlite, vis
from dataflow.manifest import build_manifest, manifest_summary
from dataflow.profile import available_profiles, load_profile
from dataflow.symtab import SymbolTable, merge_profile_facts
from dataflow.worker import process_file

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(os.path.dirname(HERE), "out")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Extract ICON call/data-flow facts.")
    ap.add_argument("--root", required=True, help="ICON model checkout")
    ap.add_argument("--extra-root", action="append", default=[],
                    help="extra source root (e.g. libiconmath), repeatable")
    ap.add_argument("--profile", default="cpu-gcc,gpu-nvhpc",
                    help="comma-separated build profiles, or 'all'")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--cache-dir", default=None,
                    help="fact cache directory (default: <out>/.cache)")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--include-tests", action="store_true",
                    help="also parse test sources (off by default)")
    ap.add_argument("--include", action="append", default=[],
                    help="extra include directory for the preprocessors")
    ap.add_argument("--components", default=None,
                    help="comma-separated component filter (src subdirectory names)")
    ap.add_argument("--limit", type=int, default=None, help="limit number of files")
    ap.add_argument("--no-dot", action="store_true", help="skip GraphViz export")
    ap.add_argument("--no-sqlite", action="store_true")
    ap.add_argument("--vis", action="store_true",
                    help="export the static call-graph viewer data (vis/)")
    ap.add_argument("--vis-dir", default=None,
                    help="viewer output directory (default: <repo>/vis)")
    ap.add_argument("--no-vis-layout", action="store_true",
                    help="skip the Node layout.json step")
    ap.add_argument("--vis-layout-script", default=None)
    ap.add_argument("--quiet", action="store_true")
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    t_start = time.time()
    model_root = os.path.abspath(args.root)
    if not os.path.isdir(model_root):
        log(f"error: model root not found: {model_root}")
        return 2
    out_dir = os.path.abspath(args.out)
    cache_dir = os.path.abspath(args.cache_dir or os.path.join(out_dir, ".cache"))
    os.makedirs(out_dir, exist_ok=True)

    if args.profile == "all":
        profile_names = available_profiles()
    else:
        profile_names = [p.strip() for p in args.profile.split(",") if p.strip()]
    profiles = [load_profile(name) for name in profile_names]

    files = build_manifest(model_root, args.extra_root, include_tests=args.include_tests)
    if args.components:
        wanted = {c.strip() for c in args.components.split(",") if c.strip()}
        files = [f for f in files if f.component in wanted]
    if args.limit:
        files = files[: args.limit]
    if not files:
        log("error: no source files matched")
        return 2
    msum = manifest_summary(files)
    log(f"manifest: {msum['files']} files ({msum['by_language']}), "
        f"{msum['bytes'] / 1e6:.1f} MB")
    log(f"profiles: {[p.name for p in profiles]}")

    include_dirs = [os.path.abspath(p) for p in args.include]
    for root in args.extra_root:
        for sub in ("include", "src", "src/include"):
            p = os.path.join(os.path.abspath(root), sub)
            if os.path.isdir(p):
                include_dirs.append(p)
        p = os.path.join(os.path.abspath(root), "src")
        if os.path.isdir(p):
            for name in os.listdir(p):
                q = os.path.join(p, name)
                if os.path.isdir(q):
                    include_dirs.append(q)
    include_dirs = list(dict.fromkeys(include_dirs))

    jobs = []
    for f in files:
        for prof in profiles:
            jobs.append({
                "path": f.path,
                "rel_path": f.rel_path,
                "component": f.component,
                "is_test": f.is_test,
                "lang": f.lang,
                "model_root": model_root,
                "include_dirs": include_dirs,
                "cache_dir": cache_dir,
                "cache": not args.no_cache,
                "cache_extra": "v1",
                "profile": asdict(prof),
            })
    log(f"jobs: {len(jobs)} ({len(files)} files x {len(profiles)} profiles), jobs_parallel={args.jobs}")

    results: dict[str, list[dict]] = {}
    tier_counts: dict[str, int] = {}
    cache_hits = 0
    failures = 0
    t_extract = time.time()
    if args.jobs <= 1:
        iterator = (process_file(j) for j in jobs)
        executor = None
    else:
        executor = ProcessPoolExecutor(max_workers=args.jobs)
        futures = {executor.submit(process_file, j): j for j in jobs}
        iterator = None

    def handle(job, res):
        nonlocal cache_hits, failures
        facts = res["facts"]
        if res.get("cached"):
            cache_hits += 1
        tier_counts[facts.get("tier", "failed")] = tier_counts.get(facts.get("tier", "failed"), 0) + 1
        if facts.get("tier") == "failed" or not facts.get("parser_ok", True):
            failures += 1
        results.setdefault(job["path"], []).append(facts)

    if executor is None:
        for i, (job, res) in enumerate(zip(jobs, iterator), 1):
            handle(job, res)
            if not args.quiet and i % 50 == 0:
                log(f"  {i}/{len(jobs)} files, {time.time() - t_extract:.0f}s, cache hits {cache_hits}")
    else:
        try:
            for i, future in enumerate(as_completed(futures), 1):
                job = futures[future]
                try:
                    res = future.result()
                except Exception as exc:  # pragma: no cover
                    log(f"worker failed for {job['path']}: {exc}")
                    failures += 1
                    continue
                handle(job, res)
                if not args.quiet and i % 50 == 0:
                    log(f"  {i}/{len(jobs)} files, {time.time() - t_extract:.0f}s, "
                        f"cache hits {cache_hits}")
        finally:
            executor.shutdown(wait=True)
    t_extract_done = time.time()

    merged = []
    for path, flist in results.items():
        merged.append(merge_profile_facts(flist))
    merged.sort(key=lambda f: (f.get("rel_path", ""), f.get("file", "")))
    log(f"extracted {len(merged)} files: tiers={tier_counts}, cached={cache_hits}, "
        f"suspect={failures}, wall={t_extract_done - t_extract:.1f}s")

    t_analysis = time.time()
    sym = SymbolTable(merged)
    log(f"symbols: {len(sym.modules)} modules, {len(sym.procs)} procedures, "
        f"{len(sym.types)} types, {sum(len(v) for v in sym.module_vars.values())} module vars")

    direct: dict[str, list[dict]] = {}
    mismatches: list[dict] = []
    for pid, proc in sym.procs.items():
        accs = intraproc.analyse_proc(sym, proc)
        direct[pid] = accs
        mismatches.extend(intraproc.intent_mismatches(proc, accs))
    log(f"intra-proc: {sum(len(v) for v in direct.values())} direct accesses, "
        f"{len(mismatches)} intent mismatches")

    link = linker_mod.link(sym)
    resolved = sum(1 for sites in link.calls.values() for c in sites if not c.callee.startswith("ext:"))
    total = resolved + sum(1 for sites in link.calls.values() for c in sites if c.callee.startswith("ext:"))
    log(f"linker: {total} call sites, {resolved} resolved "
        f"({(resolved / total * 100) if total else 0:.1f}%), "
        f"{len(link.stubs)} external nodes, {len(link.unresolved)} unresolved")

    t_ip = time.time()
    inter = interproc.propagate(sym, link, direct)
    log(f"inter-proc: {len(inter.summaries)} summaries, {len(inter.passes)} pass edges, "
        f"{inter.iterations} worklist rounds, {time.time() - t_ip:.1f}s")

    exec_info = execspace.apply(sym, merged, inter.accesses)
    residency_info = residency.build(sym, exec_info, inter.accesses)
    log(f"exec-space: {dict(sorted({s: sum(1 for v in exec_info['exec_by_proc'].values() if v == s) for s in set(exec_info['exec_by_proc'].values())}.items()))}")
    log(f"residency: {residency_info['summary']}")

    file_meta = {
        f.get("file"): {
            "rel_path": f.get("rel_path"), "component": f.get("component"),
            "is_test": f.get("is_test"), "lang": f.get("lang"),
        }
        for f in merged
    }
    timings = {
        "manifest_s": round(t_extract - t_start, 2),
        "extract_s": round(t_extract_done - t_extract, 2),
        "analysis_s": round(time.time() - t_analysis, 2),
        "total_s": round(time.time() - t_start, 2),
        "jobs": args.jobs, "jobs_total": len(jobs),
    }
    worker_stats = {
        "jobs": len(jobs), "files": len(files), "cache_hits": cache_hits,
        "tiers": tier_counts, "suspect_files": failures,
    }

    t_export = time.time()
    idx = index.build(sym, link, inter, exec_info, file_meta, model_root,
                      [p.name for p in profiles], timings, msum)
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(idx, fh, separators=(",", ":"))
    log(f"wrote index.json: {idx['summary']}")

    ent = entities.build(os.path.join(out_dir, "entities.json"), inter, exec_info, residency_info)
    log(f"wrote entities.json: {ent}")

    alias_rows = [
        {"proc": pid, "left": a.get("left"), "right": a.get("right"), "line": a.get("line")}
        for pid, proc in sym.procs.items() for a in proc.get("aliases", [])
    ]
    with open(os.path.join(out_dir, "passes.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "passes": inter.passes,
            "aliases": alias_rows,
            "callbacks": link.callbacks,
            "bindc_links": link.bindc_links,
            "summary": {
                "passes": len(inter.passes),
                "aliases": len(alias_rows),
                "callbacks": len(link.callbacks),
                "bindc_links": len(link.bindc_links),
            },
        }, fh, separators=(",", ":"))
    log(f"wrote passes.json: {len(inter.passes)} pass edges, "
        f"{len(link.callbacks)} callbacks, {len(link.bindc_links)} bind(c) links")

    sh = shards.build(out_dir, sym, link, inter, exec_info, residency_info, file_meta)
    log(f"wrote {sh['shards']} detail shards ({sh['accesses']} accesses)")

    cov = coverage.build(os.path.join(out_dir, "coverage.json"), merged, sym, link, inter,
                         exec_info, msum, timings, mismatches, worker_stats, residency_info)
    log(f"wrote coverage.json: {cov['calls']['resolved']} resolved, "
        f"{cov['calls']['external_stub']} stubbed, "
        f"{cov['calls']['resolution_rate'] * 100:.1f}% strict resolution")

    if not args.no_dot:
        cg = dot.call_graph(os.path.join(out_dir, "callgraph.dot"), sym, link, exec_info)
        df = dot.data_flow(os.path.join(out_dir, "dataflow.dot"), sym, inter, exec_info, link.stubs)
        log(f"wrote callgraph.dot ({cg}) and dataflow.dot ({df})")
    if not args.no_sqlite:
        sqlite.build(os.path.join(out_dir, "dataflow.sqlite"), sym, link, inter,
                     exec_info, residency_info)
        log("wrote dataflow.sqlite")

    if args.vis:
        repo_root = os.path.dirname(os.path.dirname(HERE))
        vis_dir = os.path.abspath(args.vis_dir or os.path.join(repo_root, "vis"))
        t_vis = time.time()
        source = vis.source_from_pipeline(sym, link, inter, exec_info,
                                          file_meta, model_root)
        source["profiles"] = [p.name for p in profiles]
        vres = vis.build(source, vis_dir)
        log(f"wrote viewer data -> {vis_dir}: {vres['graph']}, "
            f"{vres['traces']['groups']} trace groups, "
            f"{vres['search']['entries']} search entries "
            f"({time.time() - t_vis:.1f}s)")
        if not args.no_vis_layout:
            graph_path = os.path.join(vis_dir, "graph.json")
            layout_path = os.path.join(vis_dir, "layout.json")
            if vis.run_layout(graph_path, layout_path,
                              args.vis_layout_script or
                              os.path.join(repo_root, "build_layout.js")):
                log("wrote vis/layout.json")
            else:
                log("warning: layout.json skipped (node or build_layout.js unavailable)")

    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "model_root": model_root,
            "extra_roots": [os.path.abspath(p) for p in args.extra_root],
            "profiles": [p.name for p in profiles],
            "summary": msum,
            "files": [f.to_dict() for f in files],
            "timings": timings,
            "export_s": round(time.time() - t_export, 2),
        }, fh, indent=1)
    log(f"done in {time.time() - t_start:.1f}s -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
