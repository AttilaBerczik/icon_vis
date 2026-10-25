"""Per-file worker: preprocess, parse, extract facts, cache.

This module is imported by the process pool. Keep the entry point top-level and
pass plain dictionaries so it pickles cleanly.
"""

from __future__ import annotations

import os
import time
import traceback

from .cache import FactCache, cache_key
from .directives import scan_directives
from .frontends import cpp_treesitter, fortran_fparser, fortran_regex, fortran_treesitter
from .preprocess import preprocess_cpp, preprocess_fortran
from .profile import Profile


def process_file(job: dict) -> dict:
    t0 = time.time()
    path = job["path"]
    lang = job["lang"]
    profile = Profile(
        name=job["profile"]["name"],
        fortran_defines=job["profile"].get("fortran_defines", {}),
        fortran_undefines=job["profile"].get("fortran_undefines", []),
        cpp_defines=job["profile"].get("cpp_defines", {}),
        cpp_undefines=job["profile"].get("cpp_undefines", []),
    )
    cache = FactCache(job["cache_dir"], enabled=job.get("cache", True))
    key = cache_key(path, lang, profile.cache_signature(), extra=job.get("cache_extra", ""))
    cached = cache.get(key)
    if cached is not None:
        cached["_cached"] = True
        return {"facts": cached, "cached": True, "key": key, "ms": 0, "tier": cached.get("tier")}

    result = {
        "file": path,
        "rel_path": job["rel_path"],
        "component": job["component"],
        "is_test": job.get("is_test", False),
        "lang": lang,
        "profile": profile.name,
        "diagnostics": [],
        "errors": [],
        "t_cpp": 0.0,
        "t_parse": 0.0,
    }
    try:
        if lang == "fortran":
            pre = preprocess_fortran(
                path, profile.cpp_args(),
                model_root=job.get("model_root"),
                extra_include_dirs=job.get("include_dirs", []),
            )
            result["preprocess_tool"] = pre.tool
            result["diagnostics"].extend(pre.diagnostics)
            directives = scan_directives(pre.text, pre.linemap)
            t_parse = time.time()
            facts = None
            try:
                facts = fortran_fparser.parse(path, job["rel_path"], pre.text, pre.linemap, profile.name)
                tier = "fparser"
            except Exception as exc:
                result["errors"].append(
                    f"fparser: {type(exc).__name__}: {str(exc).splitlines()[0][:300]}"
                )
                if fortran_treesitter.available():
                    try:
                        facts = fortran_treesitter.parse(path, job["rel_path"], pre.text,
                                                         pre.linemap, profile.name)
                        tier = "treesitter"
                    except Exception as exc2:
                        result["errors"].append(
                            f"treesitter: {type(exc2).__name__}: {str(exc2)[:300]}"
                        )
                if facts is None:
                    facts = fortran_regex.parse(path, job["rel_path"], pre.text,
                                                pre.linemap, profile.name)
                    tier = "regex"
            facts["tier"] = tier
            facts["directives"] = directives
            facts["parser_ok"] = tier in ("fparser", "treesitter")
            result["t_parse"] = time.time() - t_parse
        else:
            pre = preprocess_cpp(
                path, profile.cpp_defines, profile.cpp_undefines,
                model_root=job.get("model_root"),
                extra_include_dirs=job.get("include_dirs", []),
            )
            result["preprocess_tool"] = pre.tool
            result["diagnostics"].extend(pre.diagnostics)
            directives = scan_directives(pre.text, pre.linemap)
            t_parse = time.time()
            facts = cpp_treesitter.parse(path, job["rel_path"], pre.text, pre.linemap,
                                         profile.name)
            facts["tier"] = "cpp"
            facts["directives"] = directives
            facts["parser_ok"] = True
            result["t_parse"] = time.time() - t_parse
        facts["rel_path"] = job["rel_path"]
        facts["component"] = job["component"]
        facts["is_test"] = job.get("is_test", False)
        facts["profiles"] = [profile.name]
        facts["diagnostics"] = result["diagnostics"][:40]
        facts["errors"] = result["errors"][:10]
        facts["_ts"] = {"cpp": result["t_cpp"], "parse": result["t_parse"]}
        cache.put(key, facts)
        return {
            "facts": facts, "cached": False, "key": key,
            "ms": round((time.time() - t0) * 1000, 1), "tier": facts.get("tier"),
        }
    except Exception as exc:  # never lose a file
        result["errors"].append(f"worker: {type(exc).__name__}: {str(exc)[:300]}")
        result["traceback"] = traceback.format_exc()[:2000]
        result["parser_ok"] = False
        result["tier"] = "failed"
        result["schema"] = 1
        result["modules"] = []
        result["procedures"] = []
        result["types"] = []
        result["module_vars"] = []
        result["directives"] = []
        result["profiles"] = [profile.name]
        return {
            "facts": result, "cached": False, "key": key,
            "ms": round((time.time() - t0) * 1000, 1), "tier": "failed",
        }
