# Call Graph Generation

This folder contains the tooling that produces the DOT files consumed by the
icon_vis viewer. Everything needed to regenerate the graph now lives here, in
the repository, instead of in scattered local copies.

## Contents

| File | Purpose |
| --- | --- |
| `callGraph` | Perl parser that turns Fortran sources into `callgraph.dot`. Fork of [koknat/callGraph](https://github.com/koknat/callGraph) (GPL, see `LICENSE`). |
| `callGraph.orig` | The unmodified upstream `callGraph`, kept for reference/diffing. |
| `add_folders_to_dot.py` | Post-processes `callgraph.dot`, prefixing each node label with its source folder to produce `callgraph_folders.dot`. |
| `generate_callgraph.sh` | Wrapper that runs the whole pipeline. **This is the entry point to use.** |
| `test/` | Upstream regression fixtures/tests for `callGraph`. |

## Changes vs. upstream

* **`callGraph`** — every emitted edge now carries the number of call sites
  between its two functions as a GraphViz `weight` attribute:

  ```
  node2 -> node1 [pos="...", weight=3];
  ```

  The count already existed internally (`$call_graph->{caller}{calls}{callee}`,
  accumulated in `parseFiles()`); upstream simply never wrote it to the DOT.
  The only change is in `graph::generate()` where the edge is added. Diff
  against `callGraph.orig` to see it.

* **`add_folders_to_dot.py`** — turned into a proper CLI
  (`--source-dir`, `--input`, `--output`) instead of hard-coded paths. It only
  rewrites `label="..."`, so the numeric, unquoted `weight=...` passes through
  untouched.

> `weight` is a *static* count of textual call sites, not runtime call
> frequency. If function `A` contains three `call B()` statements, the edge
> `A -> B` gets `weight=3`.

## Requirements

* `perl` with the GraphViz CPAN module: `sudo cpanm install GraphViz`
* `python3`

## Usage

From this folder:

```bash
./generate_callgraph.sh
```

Or with options:

```bash
./generate_callgraph.sh --source /path/to/icon/src --output /path/to/out
```

See `./generate_callgraph.sh --help`. By default the script mirrors the
historical `callGraph ../src/*/*` command (files directly inside each
first-level source folder); pass `--recursive` to include nested folders.

The two output files are written to the repository root:

* `callgraph.dot` — plain graph, edges weighted by call count.
* `callgraph_folders.dot` — same graph with folder-prefixed labels; **this is
  the file the viewer loads.**
