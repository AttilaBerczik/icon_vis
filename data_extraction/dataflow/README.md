# Data-flow extraction

Extracts a function-level call graph and a field-path data-flow graph from a
mixed **Fortran + C++/Kokkos** ICON checkout. This is the implementation of
`dataflow_extraction_plan.md` (v2).

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install -r data_extraction/dataflow/requirements.txt
```

The Fortran preprocessor uses the system `cpp` (GCC). fparser2 is the primary
frontend; tree-sitter-fortran and a regex skeleton are automatic fallbacks.
C++ uses pcpp + tree-sitter-cpp with length-preserving Kokkos/CUDA macro
masking.

## Run

```bash
.venv/bin/python data_extraction/dataflow/extract.py \
    --root /home/attila/experiment/icon-model \
    --extra-root data_extraction/libiconmath-main \
    --profile cpu-gcc,gpu-nvhpc \
    --jobs 8 \
    --out data_extraction/out
```

Useful flags:

* `--components atm_dyn_iconam,io` – restrict to source components.
* `--limit N` – smoke-test on the first N files.
* `--include-tests` – parse `test/` sources too (off by default).
* `--no-cache` – ignore the content-addressed fact cache.
* `--include DIR` – extra preprocessor include directory.
* `--no-dot`, `--no-sqlite` – skip optional exports.
* `--vis` – export the static call-graph viewer data (`vis/`): graph, cached
  layout, per-component parameter shards, sorted data search index and 256
  precomputed lifecycle shards. Add `--no-vis-layout` to skip the Node layout
  step, or `--vis-dir DIR` to write somewhere else. All JSON files also get
  `.br`/`.gz` copies for a precompressed static server.

The cache lives in `<out>/.cache`. After a tool-version bump it is
automatically invalidated. Re-runs with warm cache only re-parse changed files:
the 967-file full run takes about 2.5 min cold on 8 workers and a few seconds
warm, plus global analysis.

## Output

| File | Contents |
|---|---|
| `out/index.json` | functions, IDs, params with declared+inferred intent, exec space, direct read/write entity ids, resolved call edges, external stubs |
| `out/entities.json` | every data entity with its writer set and reader set, exec spaces, OpenACC/Kokkos residency events |
| `out/passes.json` | inter-procedural `passes_to` edges, may-aliases, `c_funloc` callbacks, `bind(c)` links |
| `out/detail/<component>/<module>.json` | direct per-function accesses with file/line/mode, aliases, resolved calls, directives, residency events, and a compact list of propagated entities |
| `out/coverage.json` | parser tiers, unresolved calls/stubs by library, profile merge stats, intent mismatches, timings, exec-space counts |
| `out/callgraph.dot` | resolved function call graph, edge weight = number of call sites |
| `out/dataflow.dot` | bipartite function ↔ data-entity graph for source-level direct accesses (`read`/`write`/`readwrite`); inter-procedural effects are in `passes.json`/`index.json` |
| `out/dataflow.sqlite` | indexed tables: `functions`, `params`, `entities`, `types`, `variables`, `accesses`, `calls`, `passes`, `links`, `residency_events`, `findings` |
| `out/manifest.json` | exact file list, profiles, include roots, timings |
| `vis/graph.json` + `vis/layout.json` | static viewer graph and its cached ordering (`--vis`) |
| `vis/fn/<component>.json` | per-function parameters, intents, ranks and lifecycle group ids |
| `vis/search.json` | sorted field/parameter/variable/type search index (rows carry declaring/declared type) |
| `vis/trace/<xx>.json` | 256 precomputed lifecycle shards (create/write/read/pass, per-route summaries) |
| `vis/structs.json` | type pages: declaration location, `extends`, value flag, members, containment parents, holders, route counts, unresolved routes |
| `vis/struct/<xx>.json` | lazy per-type touch sets rolled up through containment (cycle-safe) |
| `vis/struct/fn/<xx>.json` | reverse function → used-data index for the explorer's **Data used here** |

Lifecycle groups merge equivalent field paths onto the type that declares the
leaf (`t_nh_state%prog%rho` ≡ `t_nh_prog%rho`), keep every raw route on the event
rows, and fold tiny value-type tails (`%x`) into their parent member. Duplicate
type names across modules are unioned for component lookup (field entities only
carry the bare name), and a component missing on an abstract `CLASS(T)` owner is
resolved through a subtype when exactly one subtype declares it. Declaration and
component lines are scanned from the original source when fparser does not expose
a span; this fixes both the `TYPE` line and multi-line component declarations.
Struct-typed dummy arguments are only unioned with actuals of the same declared
type; a field actual feeds the member group instead. Paths that still cannot be
resolved are kept verbatim and listed in `structs.json`; the usual causes are
type-bound procedure names used as field paths (`obj%method`), pointer-wrapper
types whose declarations are absent from the extracted type table, and
cross-language bridge fields. Call-site passes are otherwise treated as
**unambiguous**: a callee formal joins its actuals only when all of them resolve
to the same data entity. This keeps `hydro_adjust::rho` attached to
`t_nh_prog%rho` without merging the thousands of unrelated error-message locals
that flow through utility routines such as `mpi::finish`.

### Entity IDs

Data entities are stable strings:

* `field:t_patch%edges%cell_idx` – a typed field path. Array indices are
  dropped, so `p_patch(jg)%edges%cell_idx(je,jb,1)` and any alias to it refer
  to the same entity across the whole code base.
* `param:<function-id>::<name>` – a scalar formal parameter.
* `var:<module>::<name>` – a module variable (global state).
* `local:<function-id>::<name>` – a local.
* `this:<type>` – the implicit C++ receiver.

When a field path is rooted at a formal, it is exposed both as the typed
`field:` entity and, in the per-access records, via `root`/`root_kind`, so
inter-procedural argument binding can map callee effects back onto caller
actuals.

## Analysis pipeline

1. Manifest and language classification.
2. Per-file, per-profile preprocessing with an original-line map
   (`cpp -traditional-cpp` for Fortran, pcpp for C++, both preserving line
   markers; `.inc` locations are retained).
3. Fact extraction in worker processes (AST is discarded immediately) and a
   content-addressed JSON cache.
4. Profile merge (CPU + GPU facts deduplicated).
5. Global symbol table: modules, `USE`/`ONLY`/renames, generics, derived types,
   type-bound procedures, `CLASS` hierarchy.
6. Linker: static calls, type-bound dispatch, C++ methods, `bind(c)`,
   `c_funloc` callbacks, external stubs grouped by library.
7. Intra-procedural field-path accesses with flow-insensitive may-alias
   expansion (pointer assignment, `ASSOCIATE`, `SELECT TYPE`, C++ `this`).
8. Inter-procedural worklist propagation over the call graph, including
   virtual/callback edges; callee formal effects map onto caller actuals and
   module-variable effects propagate unchanged.
9. Execution spaces (`host`, `device`, `host_device`, `switchable(lacc)`) from
   OpenACC/OpenMP, `assert_acc_*`, `set_acc_host_or_device`, Kokkos/CUDA macros.
10. Residency events from `ENTER/EXIT DATA`, `UPDATE`, `PRESENT`,
    `add_var(lopenacc)`, `Kokkos::deep_copy`, plus conservative findings.
11. Sharded export + SQLite + GraphViz.

## Full-model run (this checkout)

The reference run used:

* model: `/home/attila/experiment/icon-model`
* extra root: `data_extraction/libiconmath-main`
* profiles: `cpu-gcc` + `gpu-nvhpc`
* 8 workers

Result (`data_extraction/out`):

| Metric | Value |
|---|---|
| files | 967 (908 Fortran, 59 C++/headers) |
| parser tiers | 904 fparser, 4 tree-sitter-fortran fallback, 59 C++ |
| modules / procedures / types | 946 / 6,699 / 666 |
| data entities | 113,690 |
| accesses | 921,060 (99,413 direct + inter-procedural effects) |
| inter-procedural `passes_to` edges | 163,179 (plus 10,815 resolved aliases) |
| call sites | 68,555, of which 47,435 resolved and 21,120 stubbed (100% resolved-or-stubbed) |
| external library nodes | 1,139 (MPI, mtime, yaxt/cdi, fortran-support, iconmath, std/Kokkos…) |
| `bind(c)` links / `c_funloc` callbacks | 6 / 13 |
| execution spaces | 5,124 host, 266 device, 220 host_device, 1,089 switchable, 1,139 external |
| residency events / conservative findings | 11,256 / 515 |

Cold run (preprocess + parse): about 5.8 min on 8 workers. Warm cache:
about 3 s to load facts, ~18 s inter-procedural fixpoint, ~50 s export.

Example queries:

```python
import json
entities = json.load(open("data_extraction/out/entities.json"))["entities"]
print(entities["field:t_nh_prog%vn"]["writers"])
print(entities["field:t_patch%edges%cell_idx"]["readers"])
```

```python
import sqlite3
con = sqlite3.connect("data_extraction/out/dataflow.sqlite")
print(con.execute("""
  SELECT function_id, mode, line, via
  FROM accesses
  WHERE entity = 'field:t_nh_prog%vn' AND mode IN ('write','readwrite')
  ORDER BY function_id
""").fetchall())
```

The strict resolution rate is ~69%; the remaining calls all become explicit
`ext:<library>:<name>` stubs because the matching submodules under
`externals/` are not checked out in this checkout. Supplying them with
`--extra-root` replaces the stubs with real nodes and edges.

## Tests

```bash
.venv/bin/python -m unittest discover -s data_extraction/dataflow/tests -v
```

The tests cover directive parsing, path normalisation/may-alias, C++ macro
masking, and a small end-to-end fixture in both languages.

## Known limits

* Submodules under `externals/` are usually not checked out; those calls become
  `ext:<library>:<name>` stubs. Use `--extra-root` to connect real code.
* C++ overloads are distinct nodes (`cpp:<scope>::<name>@<line>`) but call
  resolution is name/receiver based, without full overload/type inference.
* Field paths are canonicalised using the root type + full component chain, not
  the type of the leaf component. This is intentional (it matches the plan's
  `t_patch%edges%cell_idx` example) and keeps pointer aliases stable.
* `CLASS` dispatch is an over-approximation tagged `virtual`; alias analysis is
  flow-insensitive may-alias and tagged approximate in residency findings.
* Residency findings use a conservative global event set (no exact program
  order across the whole call graph) and are marked `approx`.
