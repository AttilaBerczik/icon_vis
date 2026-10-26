# icon_vis: project memory

Notes for whoever picks this up next, human or agent. Last updated 2026-10-26.
`README.md` is partly out of date (it still describes the old `callgraph/` Perl pipeline); trust this file where they differ.

## What this is

A D3 viewer for the call graph of the ICON climate model, which is being rewritten from Fortran to C++.
Two parts:

- **Viewer** (repo root): `index.html`, `main.js`, `parser.js`, `layout.js`, `render.js`, `panel.js`, `constants.js`.
  Serve the repo root over HTTP (`python3 -m http.server`) and open `index.html`; `fetch` does not work from `file://`.
- **Extraction** (`data_extraction/dependency and flow/`): `extract_graph.py` parses Fortran (regex) and C++ (libclang)
  and writes one networkx node-link JSON per code base. That folder has its own `CLAUDE.md` with the rules, schema
  pointers and limitations. Read it before touching the extractor.

## Data sources

| File | Made by | Contents |
|---|---|---|
| `callgraph_folders.dot` | old Perl `callGraph` (removed from the working tree, still in git history) | ICON call graph; the viewer's default |
| `callgraph.dot` | same, without folder names | not loaded by the viewer |
| `output/<name>.json` | `data_extraction/dependency and flow/generate_callgraph.sh -f <name>` | new format: calls, structs, variables, data flow, GPU info |

`output/gridman.json` and `output/libiconmath.json` are generated from the test sources in `repositories/`
(gitignored: `gridman-main`, no GPU code; `libiconmath-main`, Fortran + C++/Kokkos + OpenACC).
The ICON source itself is not on this machine, so there is no ICON JSON yet.

The new extractor was checked against the old Perl pipeline on both test repositories: every old node and call edge
is present with the same weight; the new one finds more (generic interfaces, more procedures).

## Viewer: current state

- A dropdown next to the title picks the graph (`GRAPH_SOURCES` in `constants.js`; add a line to add a graph).
  Choosing one reloads the page with `?graph=<id>` so all state is rebuilt.
- `parseGraphJson` (`parser.js`) turns the JSON into the same shape as `parseDot`: node label `folder\nfile\nfunction`,
  only `kind == "function"` nodes and `kind == "call"` edges. **All other JSON content (variables, flow, GPU lines,
  gpu_inputs, structs) is deliberately ignored for now**; integrating it is the next step.
- Layout root: DOT -> `icon.f90` / `__MAIN__`; JSON -> the `program: true` node in `icon.f90`, otherwise every function
  without callers (libraries). `buildLevels` / `makeDAG` in `layout.js` accept an array of roots for this.
- Library graphs render very wide (most functions are entry points). Expected, not a bug.

## Environment gotchas

- System python has no pip/ensurepip. `.venv/` at the repo root was made with `uv` and holds `libclang` (and `networkx`,
  only for checking output). `generate_callgraph.sh` uses it automatically.
- Kokkos C++ only parses with the Kokkos headers. A Kokkos build lives in
  `~/repositories/call graph extraction test/build-libiconmath/_deps/`; the exact `-i` folders are in the extractor's CLAUDE.md.
- Browser testing: Playwright from `~/repositories/revisit/node_modules/playwright` with the cached headless shell
  `~/.cache/ms-playwright/chromium_headless_shell-1243/...` (pass it as `executablePath`; the bundled version differs).
- The staged `.gitignore` ignores all of `data_extraction/`, so the extractor, its fixtures and its CLAUDE.md are not
  tracked by git. Decide whether that is intended before committing. `output/` is not ignored.

## Open items

1. Show the new JSON aspects in the viewer (variable flows, CPU/GPU lines, GPU transfers, Fortran/C++ language).
2. Run the extractor on the real ICON source and compare with `callgraph_folders.dot`.
3. Extractor tasks listed in `data_extraction/dependency and flow/CLAUDE.md` (GPU patterns, transitive GPU reachability).
4. Update `README.md` to the new pipeline.
