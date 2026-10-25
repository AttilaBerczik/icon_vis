"""Build-profile description loaded from ``profiles/*.yaml``."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import yaml

PROFILE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "profiles")


@dataclass
class Profile:
    name: str
    description: str = ""
    fortran_defines: dict[str, object] = field(default_factory=dict)
    fortran_undefines: list[str] = field(default_factory=list)
    cpp_defines: dict[str, object] = field(default_factory=dict)
    cpp_undefines: list[str] = field(default_factory=list)

    def cpp_args(self) -> list[str]:
        args = []
        for k, v in self.fortran_defines.items():
            args.append(f"-D{k}" if v is None or v is True else f"-D{k}={v}")
        for k in self.fortran_undefines:
            args.append(f"-U{k}")
        return args

    def cache_signature(self) -> str:
        return repr(
            (
                self.name,
                sorted(self.fortran_defines.items()),
                sorted(self.fortran_undefines),
                sorted(self.cpp_defines.items()),
                sorted(self.cpp_undefines),
            )
        )


def load_profile(name: str, profile_dir: str = PROFILE_DIR) -> Profile:
    """Load a profile by name (``cpu-gcc``) or by path."""
    path = name if os.path.isfile(name) else os.path.join(profile_dir, name + ".yaml")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"profile not found: {name!r} (looked at {path})")
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return Profile(
        name=data.get("name", name),
        description=data.get("description", ""),
        fortran_defines=dict((data.get("fortran") or {}).get("defines") or {}),
        fortran_undefines=list((data.get("fortran") or {}).get("undefines") or []),
        cpp_defines=dict((data.get("cpp") or {}).get("defines") or {}),
        cpp_undefines=list((data.get("cpp") or {}).get("undefines") or []),
    )


def available_profiles(profile_dir: str = PROFILE_DIR) -> list[str]:
    if not os.path.isdir(profile_dir):
        return []
    return sorted(f[:-5] for f in os.listdir(profile_dir) if f.endswith(".yaml"))
