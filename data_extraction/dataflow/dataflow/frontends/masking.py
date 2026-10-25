"""Length-preserving masking of Kokkos/CUDA macros for tree-sitter-cpp.

The replacement text always has exactly the same length as the matched macro,
so byte offsets and line numbers in the source remain valid. Every masked macro
is also recorded as an execution-space marker for the C++ frontend.
"""

from __future__ import annotations

import re

# (regex, replacement, marker kind, execution space)
_MASKS: list[tuple[re.Pattern, str, str, str]] = [
    (re.compile(r"\bKOKKOS_CLASS_LAMBDA\b"), "[=,*this]", "KOKKOS_CLASS_LAMBDA", "device"),
    (re.compile(r"\bKOKKOS_LAMBDA\b"), "[=]", "KOKKOS_LAMBDA", "device"),
    (re.compile(r"\bKOKKOS_(?:INLINE_)?(?:FORCEINLINE_)?FUNCTION\b"), "inline", "KOKKOS_FUNCTION", "host_device"),
    (re.compile(r"\b__host__\s+__device__\b"), "  ", "__host__ __device__", "host_device"),
    (re.compile(r"\b__device__\s+__host__\b"), "  ", "__device__ __host__", "host_device"),
    (re.compile(r"\b__global__\b"), "  ", "__global__", "device"),
    (re.compile(r"\b__device__\b"), "  ", "__device__", "device"),
    (re.compile(r"\b__host__\b"), "  ", "__host__", "host"),
    (re.compile(r"\bextern\s+template\b"), "template", "extern template", "none"),
    # HIP spelling of a kernel
    (re.compile(r"\b__launch_bounds__\s*\([^)]*\)"), "", "__launch_bounds__", "none"),
]


def mask_source(text: str) -> tuple[str, list[dict]]:
    """Return (masked text, exec-space markers).

    Markers are ``{macro, kind, line (1-based), space}``. Lines refer to the
    (already preprocessed) text handed in.
    """
    markers: list[dict] = []

    def replace(match: re.Match, replacement: str, macro: str, space: str) -> str:
        value = replacement
        # Preserve newlines inside the matched region (rare, but possible in
        # multiline macro invocations such as __launch_bounds__).
        if "\n" in match.group(0):
            parts = match.group(0).split("\n")
            value = "\n".join(
                (replacement if i == 0 else "").ljust(len(part))
                for i, part in enumerate(parts)
            )
        else:
            value = value.ljust(len(match.group(0)))[: len(match.group(0))]
        if space != "none":
            markers.append({
                "macro": macro,
                "kind": "exec_marker",
                "line": text.count("\n", 0, match.start()) + 1,
                "space": space,
            })
        return value

    out = text
    for pattern, replacement, macro, space in _MASKS:
        out = pattern.sub(lambda m, r=replacement, n=macro, s=space: replace(m, r, n, s), out)
    return out, markers
