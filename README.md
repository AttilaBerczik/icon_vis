# icon_vis

Call Graph Visualization for `icon.f90`

## Description

This project visualizes the full reachable call graph of the `icon.f90` codebase using D3.js. It parses `.dot` callgraph files to build an interactive node and edge visualization. The visualization incorporates a true Sugiyama-style layer assignment (Longest-Path) combined with a Node Promotion Heuristic to optimally crush the width of the graph. It also performs edge crossing-reduction algorithms to optimize the layout, grouping nodes by file and folder into structured bounding boxes.

## Architecture

The visualization logic is split into multiple focused JavaScript files for better maintainability:

* **`index.html`**: The main user interface containing controls (toggles for edges, file boxes, and folder boxes) and the visualization container.
* **`parser.js`**: Parses the raw Graphviz `.dot` files (`callgraph.dot`) into a usable internal format of nodes and edges.
* **`layout.js`**: Handles the heavy lifting for calculating graph layout. It breaks cycles using DFS, assigns nodes to strict downward layers using the Longest-Path algorithm, and inserts invisible "Dummy Nodes" for edges spanning multiple layers. It applies a **Node Promotion Heuristic** to push nodes to higher layers, deleting dummy nodes and compressing the graph's horizontal width. It then optimizes the layout via simulated annealing to minimize edge crossings within file columns.
* **`render.js`**: Responsible for the visual representation using D3.js. It renders nodes, edges, horizontal level lines, and colored file and folder bounding boxes.
* **`main.js`**: The central entry point that loads the `.dot` data, ties the parser, layout, and rendering logic together, and initializes UI event listeners.
