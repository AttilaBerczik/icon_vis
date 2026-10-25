"""Coverage report: parser tiers, unresolved calls, stubs, profiles, intent."""

from __future__ import annotations

import json
from collections import Counter, defaultdict


def build(path: str, file_facts: list[dict], sym, linker, interproc, exec_info,
          manifest_summary: dict, timings: dict, intra_mismatches: list[dict],
          worker_stats: dict, residency_info: dict | None = None) -> dict:
    tiers = Counter()
    files_by_lang = Counter()
    failures = []
    diagnostics = []
    profile_diff = []
    directives = Counter()
    execs = Counter()
    non_primary = []
    for f in file_facts:
        tiers[f.get("tier", "unknown")] += 1
        files_by_lang[f.get("lang", "unknown")] += 1
        if f.get("tier") not in ("fparser", "cpp"):
            non_primary.append({"file": f.get("rel_path"), "tier": f.get("tier"),
                                "diagnostics": f.get("diagnostics", [])[:3],
                                "errors": f.get("errors", [])[:3]})
        if not f.get("parser_ok", True):
            failures.append({"file": f.get("rel_path"), "tier": f.get("tier"),
                             "diagnostics": f.get("diagnostics", [])[:5]})
        if f.get("diagnostics"):
            diagnostics.append({"file": f.get("rel_path"),
                                "messages": f["diagnostics"][:5]})
        if len(f.get("profiles", [])) > 1:
            profile_diff.append({"file": f.get("rel_path"), "profiles": f.get("profiles")})
        for d in f.get("directives", []):
            directives[f"{d.get('kind')}:{d.get('directive')}"] += 1
    for space in exec_info["exec_by_proc"].values():
        execs[space] += 1

    unresolved_by_lib = Counter()
    for u in linker.unresolved:
        unresolved_by_lib[u.get("library", "unknown")] += 1
    stubs_by_lib = Counter(s.get("library", "unknown") for s in linker.stubs.values())

    intent_unknown = 0
    for p in sym.procs.values():
        for param in p.get("params", []):
            if not param.get("intent") and p.get("lang") == "fortran":
                intent_unknown += 1

    calls_resolved = sum(1 for sites in linker.calls.values() for c in sites
                         if not c.callee.startswith("ext:"))
    calls_external = sum(1 for sites in linker.calls.values() for c in sites
                         if c.callee.startswith("ext:"))
    total_calls = calls_resolved + calls_external

    report = {
        "manifest": manifest_summary,
        "files": {
            "by_language": dict(files_by_lang),
            "parser_tiers": dict(tiers),
            "non_primary_tier_files": non_primary,
            "parser_failures": failures,
            "diagnostics": diagnostics[:200],
            "profile_merged_files": len(profile_diff),
        },
        "symbols": {
            "modules": len(sym.modules),
            "procedures": len(sym.procs),
            "functions_by_language": dict(Counter(p.get("lang") for p in sym.procs.values())),
            "types": len(sym.types),
            "module_variables": sum(len(v) for v in sym.module_vars.values()),
        },
        "calls": {
            "resolved": calls_resolved,
            "external_stub": calls_external,
            "total_sites": total_calls,
            "resolution_rate": round(calls_resolved / total_calls, 4) if total_calls else 0,
            "resolved_or_stubbed_rate": 1.0 if total_calls else 0,
            "unresolved_by_library": dict(unresolved_by_lib),
            "unresolved_samples": linker.unresolved[:40],
            "external_nodes": len(linker.stubs),
            "external_by_library": dict(stubs_by_lib),
            "callbacks": len(linker.callbacks),
            "bindc_links": len(linker.bindc_links),
        },
        "dataflow": {
            "entities": len({a["entity"] for accs in interproc.accesses.values() for a in accs}),
            "accesses": sum(len(a) for a in interproc.accesses.values()),
            "passes_edges": len(interproc.passes),
            "interproc_iterations": interproc.iterations,
            "intent_mismatches": len(intra_mismatches),
            "intent_mismatch_samples": intra_mismatches[:50],
            "unknown_param_intents": intent_unknown,
        },
        "execution_space": dict(execs),
        "residency": (residency_info or {}).get("summary", {}),
        "directives": dict(directives.most_common(40)),
        "timings": timings,
        "worker": worker_stats,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    return report
