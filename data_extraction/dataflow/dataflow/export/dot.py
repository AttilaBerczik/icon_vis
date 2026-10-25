"""GraphViz exports: resolved call graph and function/entity data-flow graph."""

from __future__ import annotations


def _q(s: str) -> str:
    return '"' + (s or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def call_graph(path: str, sym, linker, exec_info) -> dict:
    lines = [
        "digraph icon_callgraph {",
        "  graph [rankdir=LR, concentrate=true, ratio=0.7];",
        '  node [shape=box, fontsize=10];',
        "  edge [fontsize=8];",
    ]
    functions = {}
    for pid, proc in sym.procs.items():
        label = f"{proc.get('name')}\\n{proc.get('module') or ''}"
        space = exec_info["exec_by_proc"].get(pid, "unknown")
        color = {"device": "#d95f02", "host_device": "#7570b3",
                 "switchable": "#e6ab02", "host": "#1b9e77"}.get(space, "#999999")
        functions[pid] = True
        lines.append(f"  {_q(pid)} [label={_q(label)}, color={_q(color)}, "
                     f"tooltip={_q(space)}, style=filled, fillcolor={_q(color + '22')}];")
    for ext_id, ext in linker.stubs.items():
        lines.append(f"  {_q(ext_id)} [label={_q(ext['name'])}, shape=ellipse, "
                     f"style=dashed, color=\"#cccccc\"];")
    for (caller, callee), weight in linker.weights.items():
        sites = [c for c in linker.calls.get(caller, []) if c.callee == callee]
        kind = sites[0].kind if sites else "call"
        virtual = any(c.virtual for c in sites)
        style = "dashed" if kind in ("external", "callback") else "solid"
        lines.append(
            f"  {_q(caller)} -> {_q(callee)} [weight={weight}, label={_q(str(weight))}, "
            f"style={style}, tooltip={_q(kind + (' virtual' if virtual else ''))}];"
        )
    lines.append("}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return {"nodes": len(functions), "edges": len(linker.weights)}


def data_flow(path: str, sym, interproc, exec_info, stubs: dict | None = None) -> dict:
    lines = [
        "digraph icon_dataflow {",
        "  graph [rankdir=LR, concentrate=true];",
        '  node [fontsize=9];',
        "  edge [fontsize=7];",
        "  subgraph cluster_functions { node [shape=box, style=filled, fillcolor=\"#eef5ff\"];",
    ]
    for pid, proc in sym.procs.items():
        space = exec_info["exec_by_proc"].get(pid, "unknown")
        lines.append(f"    {_q('fn:' + pid)} [label={_q(pid)}, tooltip={_q(space)}];")
    lines.append("  }")
    lines.append("  subgraph cluster_entities { node [shape=ellipse];")
    entities = {}
    edges = set()
    for pid, accs in interproc.accesses.items():
        for a in accs:
            if a.get("propagated"):
                continue
            ent = a["entity"]
            if ent not in entities:
                entities[ent] = True
                kind = ent.split(":", 1)[0]
                color = {"field": "#2c7fb8", "param": "#999999", "var": "#e6550d",
                         "local": "#bbbbbb", "this": "#7b3294"}.get(kind, "#333333")
                lines.append(f"    {_q('ent:' + ent)} [label={_q(ent)}, color={_q(color)}];")
            edge = (pid, ent, "write" if a["mode"] == "write" else
                    "readwrite" if a["mode"] == "readwrite" else "read")
            if edge in edges:
                continue
            edges.add(edge)
            mode = edge[2]
            color = {"read": "#1b9e77", "write": "#d95f02", "readwrite": "#7570b3"}[mode]
            lines.append(f"    {_q('fn:' + pid)} -> {_q('ent:' + ent)} "
                         f"[label={_q(mode)}, color={_q(color)}, style=arrow];")
    lines.append("  }")
    lines.append("}")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return {"functions": len(sym.procs), "entities": len(entities), "edges": len(edges)}
