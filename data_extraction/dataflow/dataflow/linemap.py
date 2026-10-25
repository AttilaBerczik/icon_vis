"""Line maps between preprocessed source and the original files.

Both GCC ``cpp -traditional-cpp`` and pcpp emit line markers of the forms::

    # 12 "/path/to/file.f90"
    #line 12 "/path/to/file.f90"
    # 1 "/path/to/file.f90" 1 3

The frontends parse the preprocessed text after markers have been removed.
``build_line_map`` returns that clean text plus a list aligning every clean
line (1-based) with ``(original_file, original_line)``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

_MARKER = re.compile(
    r'^\s*#\s*(?:line\s+)?(\d+)(?:\s+"([^"]*)")?(?:\s+(\d+))*\s*$'
)

# Pseudo files created by cpp/pcpp. Their content is not model code.
_PSEUDO = ("<built-in>", "<command-line>", "<stdin>", "<command line>")


@dataclass
class LineMap:
    """Mapping of 1-based clean line numbers to original source locations."""

    main_file: str
    locations: list[tuple[str, int]] = field(default_factory=list)

    def get(self, line: int) -> tuple[str, int]:
        if 1 <= line <= len(self.locations):
            file, orig = self.locations[line - 1]
            if orig > 0:
                return file, orig
            return file or self.main_file, line
        return self.main_file, line

    def __len__(self) -> int:
        return len(self.locations)

    def to_dict(self) -> dict:
        return {"main_file": self.main_file, "locations": self.locations}

    @classmethod
    def from_dict(cls, data: dict) -> "LineMap":
        return cls(main_file=data["main_file"], locations=[tuple(x) for x in data["locations"]])


def build_line_map(raw: str, main_file: str) -> tuple[str, LineMap]:
    """Strip preprocessor line markers and build the alignment map.

    Lines originating in pseudo files (``<built-in>`` etc.) or with line
    number 0 are dropped, so the clean text contains only useful source.
    """
    clean_lines: list[str] = []
    locations: list[tuple[str, int]] = []
    cur_file = main_file
    cur_line = 1

    for raw_line in raw.splitlines():
        m = _MARKER.match(raw_line)
        if m:
            cur_line = int(m.group(1))
            cur_file = m.group(2) or cur_file
            continue
        if cur_file in _PSEUDO or cur_line <= 0:
            cur_line = max(cur_line, 0) + 1
            continue
        clean_lines.append(raw_line)
        locations.append((cur_file, cur_line))
        cur_line += 1

    return "\n".join(clean_lines) + ("\n" if clean_lines else ""), LineMap(main_file, locations)


def strip_markers(raw: str, main_file: str) -> str:
    """Strip markers without retaining a map (used for C++/regex fallbacks)."""
    text, _ = build_line_map(raw, main_file)
    return text
