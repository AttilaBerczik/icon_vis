# icon_vis

Call Graph Visualization for `icon.f90`

## Description

This project visualizes the call graph of the `icon.f90` codebase (up to 3 hops) using D3.js. It parses `.dot` callgraph files to build an interactive node and edge visualization. The visualization incorporates cross-reduction algorithms to optimize the layout and calculates depth to generate structured node levels, with optional grouping by file and folder bounding boxes.

## Architecture

The visualization logic is split into multiple focused JavaScript files for better maintainability:

* **`index.html`**: The main user interface containing controls (toggles for edges, file boxes, and folder boxes) and the visualization container.
* **`parser.js`**: Parses the raw Graphviz `.dot` files (`callgraph.dot`) into a usable internal format of nodes and edges.
* **`layout.js`**: Handles the heavy lifting for calculating graph layout. It determines node depths, builds levels, optimizes the layout via simulated annealing, and counts graph crossings to reduce edge intersections.
* **`render.js`**: Responsible for the visual representation using D3.js. It renders nodes, edges, horizontal level lines, and colored file and folder bounding boxes.
* **`main.js`**: The central entry point that loads the `.dot` data, ties the parser, layout, and rendering logic together, and initializes UI event listeners.
