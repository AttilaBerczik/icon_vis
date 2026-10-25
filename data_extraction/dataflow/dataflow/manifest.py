"""Source manifest: which files belong to which language/build profile."""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass, field

FORTRAN_EXT = (".f90", ".f", ".f95", ".f03", ".f08", ".fpp")
CPP_EXT = (".cpp", ".hpp", ".ipp", ".cu", ".cc", ".cxx", ".h", ".c")

SKIP_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "externals", "extern", "build",
    "build_dir", "__pycache__", ".venv", "venv", "_FortAna_Files",
    "fortana-master", "callGraph", "visualization", "run", "data",
}
TEST_DIRS = {"test", "tests", "unittest", "unit_tests"}


@dataclass
class SourceFile:
    path: str
    rel_path: str
    root: str
    lang: str  # "fortran" | "cpp"
    component: str
    size: int
    is_test: bool = False
    roles: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "rel_path": self.rel_path,
            "root": self.root,
            "lang": self.lang,
            "component": self.component,
            "size": self.size,
            "is_test": self.is_test,
            "roles": self.roles,
        }


def _language(path: str) -> str | None:
    low = path.lower()
    if low.endswith(FORTRAN_EXT):
        return "fortran"
    if low.endswith(CPP_EXT):
        return "cpp"
    return None


def _component(path: str, root: str) -> str:
    rel = os.path.relpath(path, root)
    parts = rel.split(os.sep)
    if parts[0] == "src" and len(parts) > 2:
        return parts[1]
    if parts[0] in ("ragnarok", "support"):
        return parts[0]
    return parts[0] if len(parts) > 1 else os.path.basename(root)


def _walk(root: str, include_tests: bool) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIRS and not d.startswith(".")
        )
        rel_dir = os.path.relpath(dirpath, root)
        in_test = any(part.lower() in TEST_DIRS for part in rel_dir.split(os.sep))
        for name in sorted(filenames):
            if _language(name) is None:
                continue
            if not include_tests and in_test:
                continue
            if not include_tests and fnmatch.fnmatch(name, "*_test.*"):
                continue
            found.append(os.path.join(dirpath, name))
    return found


def build_manifest(
    model_root: str,
    extra_roots: list[str] | None = None,
    include_tests: bool = False,
) -> list[SourceFile]:
    """Discover Fortran and C++ sources.

    For an ICON checkout, ``src`` is Fortran and ``ragnarok``/``support`` are
    C++/Kokkos. Any other layout is walked as a whole so the tool also works on
    libiconmath or a subdirectory.
    """
    model_root = os.path.abspath(model_root)
    files: list[SourceFile] = []
    seen: set[str] = set()

    root_specs: list[tuple[str, str]] = []  # (path, root label)
    if os.path.isdir(os.path.join(model_root, "src")):
        root_specs.append((os.path.join(model_root, "src"), model_root))
        for sub in ("ragnarok", "support"):
            if os.path.isdir(os.path.join(model_root, sub)):
                root_specs.append((os.path.join(model_root, sub), model_root))
    else:
        root_specs.append((model_root, model_root))

    for extra in extra_roots or []:
        extra = os.path.abspath(extra)
        if os.path.isdir(extra):
            root_specs.append((extra, extra))

    for root, label_root in root_specs:
        for path in _walk(root, include_tests):
            real = os.path.realpath(path)
            if real in seen:
                continue
            seen.add(real)
            lang = _language(path)
            if lang is None:
                continue
            rel = os.path.relpath(path, label_root)
            parts = rel.split(os.sep)
            is_test = any(p.lower() in TEST_DIRS for p in parts[:-1])
            files.append(SourceFile(
                path=os.path.abspath(path),
                rel_path=rel,
                root=os.path.abspath(label_root),
                lang=lang,
                component=_component(path, label_root),
                size=os.path.getsize(path),
                is_test=is_test,
            ))

    files.sort(key=lambda f: (f.lang, f.rel_path))
    return files


def manifest_summary(files: list[SourceFile]) -> dict:
    by_lang: dict[str, int] = {}
    by_component: dict[str, int] = {}
    total = 0
    for f in files:
        by_lang[f.lang] = by_lang.get(f.lang, 0) + 1
        by_component[f.component] = by_component.get(f.component, 0) + 1
        total += f.size
    return {
        "files": len(files),
        "bytes": total,
        "by_language": by_lang,
        "by_component": dict(sorted(by_component.items())),
    }
