# icon_vis

Call Graph Visualization for `icon.f90`

## Description

This project visualizes the reachable call graph of the `icon.f90` codebase using D3.js. It runs on the data-flow extraction in `data_extraction/out` and adds three linked views:

1. **Call graph** — the full reachable graph, with folder/file boxes, hidden-item filters and a cached offline layout.
2. **Parameter card** — click a function's `⟨N⟩ params` pill (or press `P`) to see its parameters, intents and inferred-intent warnings.
3. **Data lifecycle** — click a parameter to see its backward path to the origin, or search a field/parameter in **◆ Data** mode (`@rho`, `@t_nh_prog%vn`) to see every create, pass, write and read in approximate program order. The origin is marked **Start here** with its file and line.

The visualization uses a true Sugiyama-style layer assignment (Longest-Path) with a Node Promotion Heuristic and simulated-annealing ordering, grouping nodes by file and folder into bounding boxes.

## Architecture

The viewer is a static site. All expensive work is precomputed into `vis/` (gitignored) and served precompressed:

* **`index.html`** — UI: call graph, parameter card, data search, trace bar/legend, lifecycle panel and CSS.
* **`parser.js`** — `parseGraphJson()` reads `vis/graph.json` (integer ids + string tables) into the existing `{nodes, edges, edgeWeights}` shape. The legacy DOT parser stays behind `?source=dot`.
* **`layout.js`** — layer assignment, dummy nodes, node promotion and annealing. Now also exports its functions for Node, so the offline build and the browser run exactly the same code.
* **`build_layout.js`** — headless layout step: `graph.json` → `layout.json`.
* **`layout-worker.js`** — re-runs the layout off the main thread after hiding/unhiding items or toggling external libraries.
* **`render.js`** — D3 rendering, viewport culling, hidden-item handling, plus the data-trace layer (`setDataTrace` / `clearDataTrace`).
* **`dataflow-worker.js`** — fetches/parses parameter shards, the search index and trace shards off the main thread; keeps an LRU of recent traces.
* **`dataflow.js`** — promise-based worker client and the trace view model (backward chain vs. full flow).
* **`panel.js`** — side-panel tabs, including the **Lifecycle** tab (Start-here card + program-order timeline, virtualised for long lists).
* **`main.js`** — loads `vis/`, wires the search modes, parameter card/pill, trace bar and external-library folding.

Other folders:

* **`adjacency_matrix/`**: A standalone D3 adjacency-matrix view of the same call graph.
* **`callgraph/`**: The legacy Perl `callGraph` pipeline that generated the DOT files.
* **`data_extraction/`**: The Python data-flow extractor and the static viewer exporter (`data_extraction/dataflow/dataflow/export/vis.py`).

## Call Graph Generation

The DOT files are generated from the ICON Fortran sources by a vendored copy of
[`callGraph`](https://github.com/koknat/callGraph), plus a small script that adds
source-folder names to the node labels. Everything lives in `callgraph/`:

* **`callgraph/callGraph`** – parses the Fortran sources and writes
  `callgraph.dot`. Every edge carries `weight=<number of call sites>` between the
  two functions it connects.
* **`callgraph/add_folders_to_dot.py`** – prefixes each node label with its
  source folder, producing `callgraph_folders.dot` (the file the viewer loads).
* **`callgraph/generate_callgraph.sh`** – wrapper that runs the whole pipeline.

See [`callgraph/README.md`](callgraph/README.md) for full details.

## Build the static viewer data

The viewer reads everything from `vis/`. Regenerate it from the extraction
output (the warmed extraction cache makes this about 2 minutes):

```bash
.venv/bin/python data_extraction/dataflow/extract.py \
    --root /path/to/icon-model \
    --extra-root data_extraction/libiconmath-main \
    --profile cpu-gcc,gpu-nvhpc --jobs 8 \
    --out data_extraction/out \
    --vis --no-dot --no-sqlite
```

This writes `vis/graph.json`, `vis/layout.json`, per-component parameter shards
(`vis/fn/`), the sorted data search index (`vis/search.json`) and 256 lifecycle
shards (`vis/trace/`). Every file also gets `.br` and `.gz` copies. To rebuild
only the viewer from an existing `dataflow.sqlite`:

```bash
PYTHONPATH=data_extraction/dataflow .venv/bin/python -m dataflow.export.vis \
    --out data_extraction/out --vis vis
```

This path reads `dataflow.sqlite` (including its derived-type table).

If Node is available, `extract.py --vis` also runs `build_layout.js` to write
`layout.json`; otherwise run it directly:

```bash
node build_layout.js vis/graph.json vis/layout.json
```

### External stubs

External library calls (`ext:mpi:*`, Kokkos, …) are hidden by default. Tick
**External** in the toolbar to show them folded into **one node per library**;
the layout is recomputed in `layout-worker.js` so the UI stays responsive.

### Tests

```bash
.venv/bin/python -m unittest discover -s data_extraction/dataflow/tests -v
```

### Regenerating the DOT files

```bash
./callgraph/generate_callgraph.sh --source /path/to/icon/src
```

This writes `callgraph.dot` and `callgraph_folders.dot` to the repository root.
The `weight` attribute records how many times one function calls another (the
number of call sites, determined statically).

The viewer reads that weight and scales the edge stroke width logarithmically
with the call count — thicker edges mean the caller invokes the callee more
times. This applies to the main view and to every side-panel tab.

## Start

Serve the folder with a static server that understands the precompressed files:

```bash
npx http-server -b -g -c-1 -p 8080 .
```

Then open <http://127.0.0.1:8080/>. `live-server` also works, but it does not
gzip/brotli the JSON, so first paint is slower. The legacy DOT view remains at
`?source=dot` for as long as the old pipeline is kept.

Keyboard: `Ctrl/⌘+F` focuses search, `@` switches to data search, `P` toggles the
parameter card, `Esc` closes the card, then the trace, then the side tab.
