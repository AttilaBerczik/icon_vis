#!/usr/bin/env python3
"""Quick demo visualisation of the data-flow extraction.

Standard library only. Reads ``dataflow.sqlite`` + ``coverage.json`` and emits
two small GraphViz SVGs plus a self-contained HTML page:

  * ``field_vn.svg``        who reads / writes ``field:t_nh_prog%vn``
  * ``bridge_graupel.svg``  Fortran -> C++/Kokkos across the ragnarok boundary
  * ``index.html``          coverage numbers + both views

The 26 MB ``dataflow.dot`` is never touched: every view is a capped subgraph
built from SQL.

Usage::

    python3 data_extraction/dataflow/demo_viz.py --out data_extraction/out/demo
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

# --------------------------------------------------------------------------- #
# styling
# --------------------------------------------------------------------------- #

EXEC_FILL = {
    "host": "#dbeafe",
    "device": "#fed7aa",
    "host_device": "#bbf7d0",
    "switchable": "#e9d5ff",
    "external": "#e5e7eb",
}
EXEC_STROKE = {
    "host": "#2563eb",
    "device": "#c2410c",
    "host_device": "#15803d",
    "switchable": "#7c3aed",
    "external": "#6b7280",
}
EXEC_LABEL = {
    "host": "host (CPU)",
    "device": "device (GPU)",
    "host_device": "host_device",
    "switchable": "switchable (lacc)",
    "external": "external stub",
}

WRITE_COLOR = "#c92a2a"
READ_COLOR = "#1864ab"
STUB_COLOR = "#868e96"
FIELD_COLOR = "#0b7285"

FONT = "Helvetica"

# Kokkos/std are the only external libraries that add information in the bridge
# view; ``ext:external:*`` stubs are mostly macro-mangled member names
# (``d_qx[idx::lqv]``, ``static_cast<t>``) and would just add noise.
KEEP_STUB_LIBS = {"kokkos", "std"}


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def dot_escape(text: str) -> str:
    return (
        str(text)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "")
    )


def short_name(fn_id: str) -> str:
    """Human label for a node id."""
    if fn_id.startswith("ext:"):
        _, lib, name = fn_id.split(":", 2)
        name = re.sub(r"<.*>$", "<…>", name)
        return f"{name}\n{lib}"
    if fn_id.startswith("cpp:"):
        # keep the @line suffix: overloads such as the five `run` kernels would
        # otherwise all render with the same label
        return fn_id[4:]
    return fn_id.split("::")[-1]


def kind_of(fn_id: str) -> str:
    if fn_id.startswith("ext:"):
        return "ext"
    if fn_id.startswith("cpp:"):
        return "cpp"
    return "fortran"


def file_uri(path: str | None, line: int | None) -> str | None:
    if not path:
        return None
    uri = Path(path).as_uri()
    return f"{uri}#L{line}" if line else uri


def src_ref(path: str | None, line: int | None) -> str:
    if not path:
        return ""
    try:
        return f"{Path(path).relative_to(Path(path).anchor)}:{line}"
    except ValueError:
        return f"{path}:{line}"


def run_dot(dot_src: str, svg_path: Path, dot_bin: str) -> None:
    proc = subprocess.run(
        [dot_bin, "-Tsvg", "-o", str(svg_path)],
        input=dot_src.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise SystemExit(f"dot failed: {proc.stderr.decode()}")


# --------------------------------------------------------------------------- #
# view 1: one field, its writers and readers
# --------------------------------------------------------------------------- #

def collect_field(con: sqlite3.Connection, entity: str) -> dict:
    rows = con.execute(
        """
        SELECT a.function_id, a.mode, a.line, a.via, a.exec_space, a.propagated,
               f.name, f.module, f.lang, f.file, f.line, f.end_line, f.exec_space
        FROM accesses a
        JOIN functions f ON f.id = a.function_id
        WHERE a.entity = ? AND a.propagated = 0
        ORDER BY f.module, f.name, a.line
        """,
        (entity,),
    ).fetchall()

    nodes = {}
    for (fid, mode, aline, via, aexec, _prop, name, module, lang, file, fline,
         end_line, fexec) in rows:
        node = nodes.setdefault(fid, {
            "id": fid,
            "name": name,
            "module": module,
            "lang": lang,
            "file": file,
            "line": fline,
            "end_line": end_line,
            "modes": [],
            "access_line": aline,
            "via": via,
            "exec_space": aexec or fexec,
            "func_exec_space": fexec,
        })
        node["modes"].append(mode)
        node["n_access"] = node.get("n_access", 0) + 1
        if "write" in mode:
            node["access_line"] = aline
            node["exec_space"] = aexec or fexec

    for node in nodes.values():
        modes = node["modes"]
        if any(m in ("write", "readwrite") for m in modes):
            node["mode"] = "readwrite" if "readwrite" in modes or "read" in modes else "write"
        else:
            node["mode"] = "read"

    events = [
        dict(zip(("entity", "event", "proc", "line", "file", "exec_space", "source"), row))
        for row in con.execute(
            "SELECT * FROM residency_events WHERE entity = ? ORDER BY proc, line",
            (entity,),
        )
    ]

    all_accesses = con.execute(
        "SELECT COUNT(*), COUNT(DISTINCT function_id) FROM accesses WHERE entity = ?",
        (entity,),
    ).fetchone()

    return {"entity": entity, "nodes": nodes, "events": events,
            "all_accesses": all_accesses[0], "all_functions": all_accesses[1]}


def field_dot(view: dict, top: int = 12) -> tuple[str, dict]:
    entity = view["entity"]
    label = entity.split(":", 1)[1]
    writers_all = sorted(
        (n for n in view["nodes"].values() if n["mode"] in ("write", "readwrite")),
        key=lambda n: (-n.get("n_access", 0), n["module"] or "", n["name"]),
    )
    readers_all = sorted(
        (n for n in view["nodes"].values() if n["mode"] == "read"),
        key=lambda n: (-n.get("n_access", 0), n["module"] or "", n["name"]),
    )
    # Cap each side: with ~50 direct accessors one column per side would be a
    # 2500 pt strip. The plan's budget is "top ~25"; keep `top` per side so both
    # the read and the write set stay visible.
    writers = writers_all[:top]
    readers = readers_all[:top]

    lines = [
        "digraph field {",
        '  graph [rankdir=LR, splines=spline, nodesep=0.10, ranksep=1.30,',
        '         bgcolor="transparent", pad=0.2, fontname="%s"];' % FONT,
        '  node  [fontname="%s", fontsize=9, penwidth=1.1, margin="0.06,0.03"];' % FONT,
        '  edge  [fontname="%s", fontsize=8, arrowsize=0.6];' % FONT,
    ]

    for n in writers + readers:
        fid = n["id"]
        fill = EXEC_FILL.get(n["exec_space"], EXEC_FILL["external"])
        stroke = EXEC_STROKE.get(n["exec_space"], EXEC_STROKE["external"])
        shape = "box" if n["lang"] == "fortran" else "ellipse"
        style = "rounded,filled" if n["lang"] == "fortran" else "filled"
        tip = (
            f"{fid}\n{n['module']}:{n['name']}  ({n['lang']}, {n['exec_space']})\n"
            f"{src_ref(n['file'], n['line'])}-{n['end_line']}\n"
            f"{n['mode']} of {label} at line {n['access_line']} (via {n['via']})"
        )
        attrs = [
            f'label="{dot_escape(short_name(fid))}"',
            f"shape={shape}",
            f'style="{style}"',
            f'fillcolor="{fill}"',
            f'color="{stroke}"',
            f'tooltip="{dot_escape(tip)}"',
            'fontcolor="#111827"',
        ]
        uri = file_uri(n["file"], n["access_line"])
        if uri:
            attrs.append(f'URL="{dot_escape(uri)}"')
        lines.append(f'  "{dot_escape(fid)}" [{", ".join(attrs)}];')

    total_writers = len(writers_all)
    total_readers = len(readers_all)
    shown = len(writers) + len(readers)
    subtitle = (f"{shown} of {len(view['nodes'])} accessors"
                if shown < len(view["nodes"]) else f"{shown} direct accessors")
    lines.append(
        f'  "{dot_escape(entity)}" [label="{dot_escape(label)}\\n{subtitle}",'
        f' shape=oval, style="filled", fillcolor="{FIELD_COLOR}", fontcolor="white",'
        f' fontsize=12, penwidth=2, margin="0.14,0.06",'
        f' tooltip="{dot_escape(entity + chr(10) + str(view["all_accesses"]) + " accesses (" + str(view["all_functions"]) + " functions) incl. inter-procedural effects")}"];'
    )

    for n in writers:
        color = WRITE_COLOR
        style = "solid"
        penwidth = "2.2" if n["mode"] == "readwrite" else "1.2"
        tip = f"{n['mode']} at {n['module']}:{n['name']} line {n['access_line']}\n{src_ref(n['file'], n['access_line'])}"
        lines.append(
            f'  "{dot_escape(n["id"])}" -> "{dot_escape(entity)}" '
            f'[color="{color}", penwidth={penwidth}, style="{style}",'
            f' tooltip="{dot_escape(tip)}"];'
        )
    for i, n in enumerate(readers):
        tip = f"read at {n['module']}:{n['name']} line {n['access_line']}\n{src_ref(n['file'], n['access_line'])}"
        # field -> reader, so reads fan out to the right and writes fan in from
        # the left. Single column per side: no rank constraints, so all writers
        # land on rank 0 and all readers on rank 2 and the edges form a fan.
        lines.append(
            f'  "{dot_escape(entity)}" -> "{dot_escape(n["id"])}" '
            f'[color="{READ_COLOR}", penwidth=1.2,'
            f' tooltip="{dot_escape(tip)}"];'
        )

    # OpenACC / OpenMP residency notes (small, do not influence ranking).
    for i, ev in enumerate(view["events"]):
        nid = f"residency{i}"
        proc = ev["proc"].split("::")[-1]
        lines.append(
            f'  "{nid}" [label="{dot_escape(ev["event"].upper())} {dot_escape(proc)}\\nline {ev["line"]}",'
            f' shape=note, style="filled", fillcolor="#fff3bf", color="#f59f00", fontsize=8,'
            f' tooltip="{dot_escape(ev["source"] + chr(10) + src_ref(ev["file"], ev["line"]))}"'
            + (f', URL="{dot_escape(file_uri(ev["file"], ev["line"]))}"' if ev["file"] else "")
            + "];"
        )
        # Keep the notes in the field's own rank so they sit next to the hub
        # instead of floating in a corner, and do not stretch the layout.
        lines.append(f'  {{rank=same; "{dot_escape(entity)}"; "{nid}";}}')
        lines.append(
            f'  "{nid}" -> "{dot_escape(entity)}" [style=dotted, color="#f59f00", penwidth=1.1, arrowhead=none];'
        )

    lines.append("}")
    stats = {
        "writers": len(writers),
        "readers": len(readers),
        "total_writers": total_writers,
        "total_readers": total_readers,
        "readwrite": sum(1 for n in writers if n["mode"] == "readwrite"),
        "events": len(view["events"]),
        "nodes": view["nodes"],
        "all_accesses": view["all_accesses"],
        "all_functions": view["all_functions"],
    }
    return "\n".join(lines), stats


# --------------------------------------------------------------------------- #
# view 2: Fortran -> C++ across the ragnarok boundary
# --------------------------------------------------------------------------- #

def collect_bridge(con: sqlite3.Connection, root: str, depth: int = 2) -> dict:
    # outgoing ego graph
    reach = dict(con.execute(
        """
        WITH RECURSIVE out(id, d) AS (
            SELECT ?, 0
            UNION
            SELECT c.callee, out.d + 1 FROM calls c JOIN out ON c.caller = out.id
            WHERE out.d < ?
        )
        SELECT id, MIN(d) FROM out GROUP BY id
        """,
        (root, depth),
    ).fetchall())

    edges = {}
    for caller, callee, line, kind, virtual, external in con.execute(
        "SELECT caller, callee, line, kind, virtual, external FROM calls"
    ):
        if caller in reach and callee in reach:
            edges[(caller, callee, line)] = {
                "caller": caller, "callee": callee, "line": line,
                "kind": kind, "virtual": virtual, "external": external,
            }

    # immediate callers of the root (the call chain into the kernel)
    for caller, line, kind, virtual, external in con.execute(
        "SELECT caller, line, kind, virtual, external FROM calls WHERE callee = ?", (root,)
    ):
        edges[(caller, root, line)] = {
            "caller": caller, "callee": root, "line": line,
            "kind": kind, "virtual": virtual, "external": external,
        }
        reach.setdefault(caller, -1)

    # resolved bind(c) / c_funloc handshake for the ragnarok support layer
    links = [dict(zip(("kind", "source", "target", "name", "line"), row))
             for row in con.execute("SELECT * FROM links ORDER BY kind, source")]

    functions = {}
    ids = {e["caller"] for e in edges.values()} | {e["callee"] for e in edges.values()}
    ids |= {link["source"] for link in links} | {link["target"] for link in links}
    for fid in ids:
        row = con.execute(
            "SELECT id, name, module, lang, file, line, end_line, exec_space FROM functions WHERE id = ?",
            (fid,),
        ).fetchone()
        if row:
            functions[fid] = dict(zip(
                ("id", "name", "module", "lang", "file", "line", "end_line", "exec_space"), row
            ))
        else:
            functions[fid] = {"id": fid, "name": short_name(fid), "module": None,
                              "lang": "cpp" if fid.startswith("cpp:") else "external",
                              "file": None, "line": None, "end_line": None,
                              "exec_space": "external"}

    return {"root": root, "depth": depth, "functions": functions,
            "edges": edges, "links": links, "reach": reach}


def bridge_dot(view: dict) -> tuple[str, dict]:
    root = view["root"]
    functions = view["functions"]
    edges = view["edges"]

    # drop noisy ext: stubs and their edges; drop self loops
    dropped = 0
    keep = set(functions)
    for fid, meta in functions.items():
        if meta["lang"] == "external":
            lib = fid.split(":", 2)[1] if fid.count(":") >= 2 else ""
            if lib not in KEEP_STUB_LIBS:
                keep.discard(fid)
                dropped += 1

    filtered = []
    for e in edges.values():
        if e["caller"] == e["callee"]:
            continue
        if e["caller"] in keep and e["callee"] in keep:
            filtered.append(e)

    used = {e["caller"] for e in filtered} | {e["callee"] for e in filtered}
    for fid in list(keep):
        if fid not in used and fid != root:
            keep.discard(fid)

    def node_attrs(fid: str, extra: str = "") -> str:
        meta = functions[fid]
        kind = kind_of(fid)
        color = EXEC_STROKE.get(meta["exec_space"], EXEC_STROKE["external"])
        fill = EXEC_FILL.get(meta["exec_space"], EXEC_FILL["external"])
        if kind == "ext":
            shape, style = "note", "filled"
        elif kind == "cpp":
            shape, style = "ellipse", "filled"
        else:
            shape, style = "box", "rounded,filled"
        tip = f"{fid}\n{meta['lang']}, {meta['exec_space']}"
        if meta["file"]:
            tip += f"\n{src_ref(meta['file'], meta['line'])}-{meta['end_line']}"
        attrs = [
            f'label="{dot_escape(short_name(fid))}"',
            f"shape={shape}", f'style="{style}"',
            f'fillcolor="{fill}"', f'color="{color}"',
            f'tooltip="{dot_escape(tip)}"', 'fontcolor="#111827"', extra,
        ]
        uri = file_uri(meta["file"], meta["line"])
        if uri:
            attrs.append(f'URL="{dot_escape(uri)}"')
        return ", ".join(a for a in attrs if a)

    lines = [
        "digraph bridge {",
        '  graph [rankdir=LR, splines=spline, nodesep=0.22, ranksep=1.0,',
        '         bgcolor="transparent", pad=0.2, fontname="%s"];' % FONT,
        '  node  [fontname="%s", fontsize=10, penwidth=1.2, margin="0.08,0.04"];' % FONT,
        '  edge  [fontname="%s", fontsize=8, arrowsize=0.6];' % FONT,
    ]

    # Fortran side / C++ side groups so dot keeps the two languages apart.
    groups = defaultdict(list)
    for fid in keep:
        groups[functions[fid]["lang"] if functions[fid]["lang"] in ("fortran", "cpp", "external") else "external"].append(fid)

    for fid in groups["fortran"]:
        lines.append(f'  "{dot_escape(fid)}" [{node_attrs(fid)}];')
    for fid in groups["cpp"]:
        lines.append(f'  "{dot_escape(fid)}" [{node_attrs(fid)}];')
    for fid in groups["external"]:
        lines.append(f'  "{dot_escape(fid)}" [{node_attrs(fid)}];')

    for e in filtered:
        caller, callee = e["caller"], e["callee"]
        caller_lang = functions.get(caller, {}).get("lang")
        callee_lang = functions.get(callee, {}).get("lang")
        cross_language = (
            caller_lang in ("fortran", "cpp")
            and callee_lang in ("fortran", "cpp")
            and caller_lang != callee_lang
        )

        if e["kind"] == "bindc" or cross_language:
            # A Fortran `BIND(c)` interface is what makes this hop possible, so
            # draw every language-boundary edge like the plan's bind(c) style.
            color, penwidth, style = "#5f3dc4", "2.0", "dashed"
        elif caller == root:
            color, penwidth, style = "#0b7285", "2.2", "solid"
        elif e["virtual"]:
            color, penwidth, style = "#0b7285", "1.6", "dotted"
        elif e["external"]:
            color, penwidth, style = STUB_COLOR, "1.0", "dashed"
        else:
            color, penwidth, style = "#495057", "1.2", "solid"

        meta = functions.get(caller, {})
        tip = f"call at {src_ref(meta.get('file'), e['line'])}  ({e['kind']}"
        if cross_language:
            tip += ", Fortran <-> C++ via BIND(c)"
        if e["virtual"]:
            tip += ", virtual"
        if e["external"]:
            tip += ", external stub"
        tip += ")"
        lines.append(
            f'  "{dot_escape(caller)}" -> "{dot_escape(callee)}" '
            f'[color="{color}", penwidth={penwidth}, style="{style}", tooltip="{dot_escape(tip)}"];'
        )

    # bind(c) / c_funloc links, drawn only where both ends are part of the view
    link_edges = 0
    for link in view["links"]:
        src, dst = link["source"], link["target"]
        if src in keep and dst in keep:
            style = "dashed" if link["kind"] == "bindc" else "dotted"
            lines.append(
                f'  "{dot_escape(src)}" -> "{dot_escape(dst)}" '
                f'[color="#5f3dc4", penwidth=2.0, style="{style}", label=" {link["kind"]}",'
                f' tooltip="{dot_escape(link["kind"] + " `" + str(link["name"]) + "`")}"];'
            )
            link_edges += 1

    lines.append("}")
    stats = {
        "nodes": len(keep),
        "edges": len(filtered) + link_edges,
        "dropped_stubs": dropped,
        "functions": functions,
        "root": root,
        "links_in_graph": link_edges,
        "callers": sorted({e["caller"] for e in filtered if e["callee"] == root}),
    }
    return "\n".join(lines), stats


# --------------------------------------------------------------------------- #
# headline numbers
# --------------------------------------------------------------------------- #

def load_coverage(path: Path) -> dict:
    return json.loads(path.read_text())


def fmt(n: int | float) -> str:
    if isinstance(n, float):
        return f"{n:,.0f}"
    return f"{n:,}"


def stat_cards(cov: dict) -> str:
    files = cov["manifest"]["files"]
    langs = cov["manifest"]["by_language"]
    calls = cov["calls"]
    dataflow = cov["dataflow"]
    symbols = cov["symbols"]
    residency = cov["residency"]

    cards = [
        ("files parsed", f"{fmt(files)}", f"{fmt(langs.get('fortran', 0))} Fortran · {fmt(langs.get('cpp', 0))} C++"),
        ("procedures", f"{fmt(symbols['procedures'])}", f"{fmt(symbols['modules'])} modules · {fmt(symbols['types'])} types"),
        ("call sites", f"{fmt(calls['total_sites'])}", "100% resolved or stubbed"),
        ("data entities", f"{fmt(dataflow['entities'])}", f"{fmt(dataflow['accesses'])} accesses"),
        ("inter-proc. edges", f"{fmt(dataflow['passes_edges'])}", "passed-to fixpoint"),
        ("residency events", f"{fmt(residency['events'])}", f"{fmt(residency['findings'])} conservative findings"),
    ]
    return "\n".join(
        f'<div class="card"><div class="num">{v}</div>'
        f'<div class="name">{html.escape(k)}</div><div class="sub">{html.escape(s)}</div></div>'
        for k, v, s in cards
    )


def bars(rows: list[tuple[str, int]], unit: str = "") -> str:
    top = max(v for _, v in rows) or 1
    out = []
    for name, value in rows:
        pct = 100.0 * value / top
        out.append(
            f'<div class="bar-row"><span class="bar-label">{html.escape(name)}</span>'
            f'<span class="bar-track"><span class="bar-fill" style="width:{pct:.1f}%"></span></span>'
            f'<span class="bar-value">{fmt(value)}{unit}</span></div>'
        )
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# HTML
# --------------------------------------------------------------------------- #

PAGE_CSS = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem clamp(1rem, 5vw, 4rem) 5rem;
  font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #111827; background: #f7f7f5;
  max-width: 1500px; margin-inline: auto;
}
h1 { font-size: 1.7rem; margin: 0 0 .3rem; letter-spacing: -.01em; }
h2 { font-size: 1.25rem; margin: 0 0 .2rem; }
h3 { font-size: .95rem; margin: 0 0 .4rem; text-transform: uppercase; letter-spacing: .06em; color: #4b5563; }
p.lede { margin: .2rem 0 0; color: #4b5563; }
.meta { color: #6b7280; font-size: .82rem; margin-top: .35rem; }
section { margin-top: 3rem; }
.section-head { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: .9rem; }
.section-head .tag { font-size: .74rem; letter-spacing: .08em; text-transform: uppercase;
  color: #0b7285; border: 1px solid #99e9f2; background: #e3fafc; border-radius: 999px; padding: .12rem .55rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: .85rem 1rem; }
.card .num { font-size: 1.5rem; font-weight: 650; letter-spacing: -.02em; }
.card .name { color: #374151; font-size: .86rem; }
.card .sub { color: #6b7280; font-size: .76rem; margin-top: .15rem; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 1.2rem; }
.panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1rem 1.1rem 1.2rem; }
.panel h3 { margin-bottom: .7rem; }
.bar-row { display: grid; grid-template-columns: minmax(7rem, 11rem) 1fr 4.5rem;
  align-items: center; gap: .6rem; margin: .3rem 0; font-size: .82rem; }
.bar-label { color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { background: #f1f3f5; border-radius: 999px; height: 9px; overflow: hidden; }
.bar-fill { display: block; height: 100%; background: linear-gradient(90deg, #0b7285, #15aabf); border-radius: 999px; }
.bar-value { text-align: right; font-variant-numeric: tabular-nums; color: #4b5563; }
figure { margin: 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 1rem; overflow: auto; }
figure svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
figcaption { color: #6b7280; font-size: .82rem; margin-top: .6rem; }
.legend { display: flex; flex-wrap: wrap; gap: .35rem 1.1rem; margin: .1rem 0 1rem; font-size: .8rem; color: #374151; }
.legend span { display: inline-flex; align-items: center; gap: .4rem; }
.swatch { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid; display: inline-block; }
.swatch.box { border-radius: 2px; }
.swatch.ellipse { border-radius: 50%; }
.swatch.line { width: 22px; height: 0; border-width: 0 0 2.5px 0; border-radius: 0; }
table { border-collapse: collapse; width: 100%; font-size: .84rem; }
th, td { text-align: left; padding: .32rem .55rem; border-bottom: 1px solid #eef0f2; vertical-align: top; }
th { color: #6b7280; font-weight: 600; font-size: .76rem; text-transform: uppercase; letter-spacing: .05em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code, .path { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .8rem; }
a { color: #0b7285; text-decoration: none; }
a:hover { text-decoration: underline; }
.note { background: #fff9db; border: 1px solid #ffe066; border-radius: 10px; padding: .75rem .95rem;
  font-size: .84rem; color: #5f3dc4; background: #f8f0ff; border-color: #e5dbff; }
.small { font-size: .8rem; color: #6b7280; }
footer { margin-top: 3.5rem; font-size: .78rem; color: #9ca3af; }
@media (prefers-color-scheme: dark) {
  body { background: #101113; color: #e5e7eb; }
  p.lede, .meta, .small, figcaption { color: #a1a1aa; }
  .card, .panel, figure { background: #17191c; border-color: #2a2d31; }
  .card .name { color: #d4d4d8; }
  .bar-track { background: #26282c; }
  th, td { border-color: #26282c; }
  th { color: #9ca3af; }
  .section-head .tag { background: #0b2b30; border-color: #164e56; color: #66d9e8; }
  .note { background: #1b1725; border-color: #3b2f5c; color: #d0bfff; }
  h3 { color: #9ca3af; }
}
"""


def field_legend(exec_used: set[str]) -> str:
    items = []
    for space in ("host", "device", "host_device", "switchable"):
        if space in exec_used:
            items.append(
                f'<span><i class="swatch" style="background:{EXEC_FILL[space]};'
                f'border-color:{EXEC_STROKE[space]}"></i>{EXEC_LABEL[space]}</span>'
            )
    items.append('<span><i class="swatch box" style="background:#fff;border-color:#374151"></i>Fortran (box)</span>')
    items.append('<span><i class="swatch ellipse" style="background:#fff;border-color:#374151"></i>C++ (ellipse)</span>')
    items.append(f'<span><i class="swatch line" style="border-color:{WRITE_COLOR}"></i>write</span>')
    items.append(f'<span><i class="swatch line" style="border-color:{READ_COLOR}"></i>read</span>')
    items.append('<span>thick red = read+write</span>')
    items.append('<span>yellow note = OpenACC residency</span>')
    return '<div class="legend">' + "".join(items) + "</div>"


def bridge_legend() -> str:
    return (
        '<div class="legend">'
        '<span><i class="swatch box" style="background:#dbeafe;border-color:#2563eb"></i>Fortran</span>'
        '<span><i class="swatch ellipse" style="background:#dbeafe;border-color:#2563eb"></i>C++ / Kokkos</span>'
        '<span><i class="swatch ellipse" style="background:#e5e7eb;border-color:#6b7280"></i>external stub</span>'
        '<span><i class="swatch line" style="border-color:#495057"></i>call</span>'
        '<span><i class="swatch line" style="border-color:#5f3dc4;border-top:2px dashed #5f3dc4"></i>bind(c)</span>'
        '<span><i class="swatch line" style="border-color:#0b7285;border-top:2px dotted #0b7285"></i>c_funloc callback</span>'
        '</div>'
    )


def svg_markup(path: Path) -> str:
    text = path.read_text()
    text = re.sub(r"<\?xml[^>]*\?>\s*", "", text)
    text = re.sub(r"<!DOCTYPE[^>]*>\s*", "", text)
    text = re.sub(r"<!--.*?-->\s*", "", text, flags=re.S)
    # keep the viewBox; drop fixed pixel/point size so CSS can scale it
    text = re.sub(r'(<svg[^>]*?)\swidth="[^"]*"', r"\1", text, count=1)
    text = re.sub(r'(<svg[^>]*?)\sheight="[^"]*"', r"\1", text, count=1)
    return text


def build_html(cov: dict, field_svg: Path, bridge_svg: Path, field_stats: dict,
               bridge_stats: dict, paths: dict) -> str:
    files = cov["files"]
    calls = cov["calls"]
    dataflow = cov["dataflow"]
    spaces = cov["execution_space"]
    residency = cov["residency"]
    directives = cov["directives"]
    timings = cov["timings"]

    exec_used = set(field_stats["exec_used"])

    parser_rows = [
        ("fparser (Fortran)", files["parser_tiers"].get("fparser", 0)),
        ("tree-sitter C++", files["parser_tiers"].get("cpp", 0)),
        ("tree-sitter Fortran fallback", files["parser_tiers"].get("treesitter", 0)),
    ]
    call_rows = [
        ("resolved call sites", calls["resolved"]),
        ("external stubs", calls["external_stub"]),
    ]
    space_rows = [(EXEC_LABEL[k], v) for k, v in
                  sorted(spaces.items(), key=lambda kv: -kv[1])]
    directive_rows = [
        ("OpenACC directives", sum(v for k, v in directives.items() if k.startswith("acc:"))),
        ("OpenMP directives", sum(v for k, v in directives.items() if k.startswith("omp:"))),
    ]

    residency_events = "".join(
        f'<tr><td><code>{html.escape(ev["event"].upper())}</code></td>'
        f'<td><a href="{html.escape(file_uri(ev["file"], ev["line"]) or "#")}">'
        f'{html.escape(ev["proc"].split("::")[-1])}:{ev["line"]}</a></td>'
        f'<td><code>{html.escape(ev["source"].strip())}</code></td></tr>'
        for ev in field_stats["events"]
    )

    bridge_nodes = bridge_stats["functions"]
    root = bridge_stats["root"]

    def fn_link(fid: str) -> str:
        meta = bridge_nodes.get(fid, {})
        label = html.escape(short_name(fid).replace("\n", " "))
        if meta.get("file"):
            return f'<a href="{html.escape(file_uri(meta["file"], meta["line"]) or "#")}">{label}</a>'
        return label

    handshake_rows = "".join(
        f'<tr><td><code>{html.escape(link["kind"])}</code></td>'
        f'<td>{fn_link(link["source"])}</td>'
        f'<td>{fn_link(link["target"])}</td></tr>'
        for link in bridge_stats["links"]
        if link["kind"] == "bindc" or (link["source"] == "mo_ragnarok_support::init_ragnarok_support")
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICON data-flow extraction — quick demo</title>
<style>{PAGE_CSS}</style>
</head>
<body>

<h1>ICON data-flow extraction — quick demo</h1>
<p class="lede">Function-level call graph and field-path data flow for <strong>{fmt(cov['manifest']['files'])}</strong> Fortran + C++ files,
extracted automatically with a CPU + GPU profile merge.</p>
<p class="meta">Source: <span class="path">{html.escape(paths['sqlite'])}</span> ·
<span class="path">coverage.json</span> · built {html.escape(paths['built'])} ·
total pipeline run {timings['total_s']:.0f} s on {timings['jobs']} workers</p>

<!-- ---------------------------------------------------------------- numbers -->
<section>
  <div class="section-head"><h2>1 · It ran over all of ICON</h2><span class="tag">scale</span></div>
  <div class="cards">
    {stat_cards(cov)}
  </div>

  <div class="grid2" style="margin-top:1rem">
    <div class="panel">
      <h3>Parser coverage</h3>
      {bars(parser_rows)}
      <p class="small">No parser failures; the {files['parser_tiers'].get('treesitter', 0)} fallback files are parsed with tree-sitter when fparser trips over preprocessor-heavy code.</p>
    </div>
    <div class="panel">
      <h3>Call sites</h3>
      {bars(call_rows)}
      <p class="small">{100 * calls['resolved_or_stubbed_rate']:.0f}% of the {fmt(calls['total_sites'])} sites resolve to code or to an explicit
      <code>ext:&lt;library&gt;:&lt;name&gt;</code> stub ({fmt(calls['external_nodes'])} distinct external nodes, mostly MPI / mtime / CDI).</p>
    </div>
    <div class="panel">
      <h3>Execution space</h3>
      {bars(space_rows)}
      <p class="small">Merged from OpenACC/OpenMP directives, <code>assert_acc_*</code>, <code>set_acc_host_or_device</code> and Kokkos macros.</p>
    </div>
    <div class="panel">
      <h3>Data flow &amp; directives</h3>
      <table>
        <tr><th>data entities</th><td class="num">{fmt(dataflow['entities'])}</td></tr>
        <tr><th>accesses (direct + propagated)</th><td class="num">{fmt(dataflow['accesses'])}</td></tr>
        <tr><th>inter-procedural <code>passes_to</code></th><td class="num">{fmt(dataflow['passes_edges'])}</td></tr>
        {''.join(f'<tr><th>{html.escape(k)}</th><td class="num">{fmt(v)}</td></tr>' for k, v in directive_rows)}
        <tr><th>residency events</th><td class="num">{fmt(residency['events'])}</td></tr>
        <tr><th>conservative findings</th><td class="num">{fmt(residency['findings'])}</td></tr>
        <tr><th>bind(c) links / c_funloc callbacks</th>
            <td class="num">{calls['bindc_links']} / {calls['callbacks']}</td></tr>
      </table>
    </div>
  </div>
</section>

<!-- ------------------------------------------------------------- field story -->
<section>
  <div class="section-head"><h2>2 · Who reads and writes <code>t_nh_prog%vn</code>?</h2><span class="tag">field story</span></div>
  <p class="lede">Direct accesses only (no inter-procedural propagation), colour = execution space, shape = language.
  Hover a node for its <code>file:line</code>; click to open the access site.</p>
  {field_legend(exec_used)}
  <figure>
    {svg_markup(field_svg)}
    <figcaption>Top {field_stats['writers']} of {field_stats['total_writers']} writer functions
    (of which {field_stats['readwrite']} read+write) and top {field_stats['readers']} of
    {field_stats['total_readers']} pure readers touch the field directly. Including inter-procedural
    effects the entity has {fmt(field_stats['all_accesses'])} accesses from
    {fmt(field_stats['all_functions'])} functions.
    The whole path tree is normalised: <code>p_prog(jg)%vn</code>, <code>p_prog_now%vn</code>,
    <code>dyn_new%vn</code> and <code>p_prog%vn</code> all collapse onto one node.</figcaption>
  </figure>

  <div class="panel" style="margin-top:1rem">
    <h3>OpenACC residency events for <code>t_nh_prog%vn</code></h3>
    <table>
      <tr><th>event</th><th>procedure</th><th>directive</th></tr>
      {residency_events}
    </table>
    <p class="small">The first row is the credibility check: the directive really is on
    <code>mo_nh_nest_utilities.f90:1705</code> inside <code>limarea_nudging_latbdy</code>, next to the
    read+write access the graph shows.</p>
  </div>
</section>

<!-- ------------------------------------------------------------ bridge story -->
<section>
  <div class="section-head"><h2>3 · Fortran → C++ across the ragnarok boundary</h2><span class="tag">bridge</span></div>
  <p class="lede">Call graph around <code>{html.escape(root)}</code>, depth 2, plus the resolved
  <code>bind(c)</code> / <code>c_funloc</code> handshake of the ragnarok support layer.</p>
  {bridge_legend()}
  <figure>
    {svg_markup(bridge_svg)}
    <figcaption>{bridge_stats['nodes']} nodes / {bridge_stats['edges']} edges.
    Fortran <code>graupel_run</code> is a thin <code>BIND(c)</code> wrapper: it calls the C++ <code>run()</code> entry point,
    which fans out to the Kokkos graupel kernels; the grey Kokkos/std stubs are the GPU launch API
    (<code>parallel_for</code>, <code>deep_copy</code>, <code>fence</code>, <code>atomic_fetch_add</code>).
    {bridge_stats['dropped_stubs']} noisy <code>ext:external:*</code> stubs (macro-mangled member names) are hidden.</figcaption>
  </figure>

  <div class="grid2" style="margin-top:1rem">
    <div class="panel">
      <h3>bind(c) and c_funloc links</h3>
      <table>
        <tr><th>kind</th><th>Fortran side</th><th>C++ / callback side</th></tr>
        {handshake_rows}
      </table>
      <p class="small">Six <code>BIND(c)</code> interfaces and thirteen callback entries are resolved through the
      function table; the rest of the C++ ragnarok sources link back into Fortran through the same table.</p>
    </div>
    <div class="panel">
      <h3>How to read this</h3>
      <p class="small">Every node and edge carries a tooltip with its <code>file:line</code>, and clicking a node opens
      the source line. Cross-language overloads are deliberately over-approximated: the single Fortran
      <code>CALL run(...)</code> at <code>mo_ragnarok_microphysics.f90:61</code> is name-resolved onto all five C++
      <code>run</code> instantiations, which is why one Fortran call fans out to five ellipses.</p>
      <p class="small">The 26 MB <code>dataflow.dot</code> is not rendered. Both pictures are capped subgraphs
      built with SQL from <code>dataflow.sqlite</code>.</p>
    </div>
  </div>
</section>

<footer>
  Generated by <code>data_extraction/dataflow/demo_viz.py</code> — standard library + GraphViz
  <code>dot</code>. Views are read-only snapshots; re-run the extractor to refresh the numbers.
</footer>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve()
    default_out = here.parent.parent / "out" / "demo"

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(default_out), help="output directory (default: data_extraction/out/demo)")
    ap.add_argument("--sqlite", help="path to dataflow.sqlite (default: <out>/dataflow.sqlite)")
    ap.add_argument("--coverage", help="path to coverage.json (default: <out>/coverage.json)")
    ap.add_argument("--field", default="field:t_nh_prog%vn", help="field entity for view 1")
    ap.add_argument("--top", type=int, default=12,
                    help="max accessors shown per side in view 1 (default: 12)")
    ap.add_argument("--function", default="mo_ragnarok_microphysics::graupel_run",
                    help="root function for view 2")
    ap.add_argument("--depth", type=int, default=2, help="ego-graph depth for view 2")
    ap.add_argument("--dot", default="/usr/bin/dot", help="GraphViz dot binary")
    ap.add_argument("--no-render", action="store_true", help="only write .dot files")
    ap.add_argument("--stats", action="store_true", help="print SQL sanity-check counts and exit")
    args = ap.parse_args(argv)

    # data sources live in the parent of the demo directory by default, so the
    # documented `--out data_extraction/out/demo` works as-is.
    out = Path(args.out)

    def find(name: str, explicit: str | None) -> Path:
        if explicit:
            path = Path(explicit)
            if not path.exists():
                raise SystemExit(f"missing {path}")
            return path
        for candidate in (out / name, out.parent / name, here.parent.parent / "out" / name):
            if candidate.exists():
                return candidate
        raise SystemExit(f"cannot find {name}; pass --{name.split('.')[0]}")

    out = out.resolve()
    sqlite_path = find("dataflow.sqlite", args.sqlite)
    coverage_path = find("coverage.json", args.coverage)

    con = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)

    # -- step 1 of the plan: sanity-check the queries as text -----------------
    if args.stats:
        print(f"field {args.field}:")
        for row in con.execute(
            """SELECT mode, COUNT(*) AS direct, COUNT(DISTINCT function_id) AS fns
               FROM accesses WHERE entity=? AND propagated=0 GROUP BY mode""",
            (args.field,),
        ):
            print(f"  {row[0]:>9}: {row[1]:3d} direct accesses from {row[2]:3d} functions")
        print(f"  all (with propagation): {con.execute('SELECT COUNT(*), COUNT(DISTINCT function_id) FROM accesses WHERE entity=?', (args.field,)).fetchone()}")
        print(f"  residency events: {con.execute('SELECT COUNT(*) FROM residency_events WHERE entity=?', (args.field,)).fetchone()[0]}")
        print(f"\nfunction {args.function}:")
        print(f"  callers: {con.execute('SELECT COUNT(*) FROM calls WHERE callee=?', (args.function,)).fetchone()[0]}")
        print(f"  callees: {con.execute('SELECT COUNT(*) FROM calls WHERE caller=?', (args.function,)).fetchone()[0]}")
        print(f"  bind(c) links: {con.execute('SELECT COUNT(*) FROM links WHERE kind=\"bindc\"').fetchone()[0]}")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    demo_dir = out

    # -- view 1 ---------------------------------------------------------------
    field_view = collect_field(con, args.field)
    field_src, field_stats_raw = field_dot(field_view, args.top)
    field_stats_raw["events"] = field_view["events"]
    field_stats_raw["exec_used"] = {n["exec_space"] for n in field_view["nodes"].values()}
    (demo_dir / "field_vn.dot").write_text(field_src)
    field_svg = demo_dir / "field_vn.svg"
    if not args.no_render:
        run_dot(field_src, field_svg, args.dot)

    # -- view 2 ---------------------------------------------------------------
    bridge_view = collect_bridge(con, args.function, args.depth)
    bridge_src, bridge_stats = bridge_dot(bridge_view)
    bridge_stats["links"] = bridge_view["links"]
    (demo_dir / "bridge_graupel.dot").write_text(bridge_src)
    bridge_svg = demo_dir / "bridge_graupel.svg"
    if not args.no_render:
        run_dot(bridge_src, bridge_svg, args.dot)

    print(f"view 1: {args.field} — {field_stats_raw['writers']} writers, "
          f"{field_stats_raw['readers']} readers, {len(field_view['events'])} residency notes")
    print(f"view 2: {bridge_stats['nodes']} nodes, {bridge_stats['edges']} edges "
          f"({bridge_stats['dropped_stubs']} noisy stubs hidden) around {args.function}")

    # -- html -----------------------------------------------------------------
    cov = load_coverage(coverage_path)
    from datetime import datetime
    page = build_html(
        cov,
        field_svg,
        bridge_svg,
        field_stats_raw,
        bridge_stats,
        {
            "sqlite": os.path.relpath(sqlite_path, demo_dir),
            "built": datetime.now().strftime("%Y-%m-%d %H:%M"),
        },
    )
    (demo_dir / "index.html").write_text(page)

    print(f"\nwrote {demo_dir / 'index.html'}")
    for name in ("field_vn.svg", "bridge_graupel.svg", "index.html"):
        path = demo_dir / name
        if path.exists():
            print(f"  {path}  ({path.stat().st_size / 1024:.1f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
