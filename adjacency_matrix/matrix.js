async function drawMatrix() {
    // 1. Fetch file from parent folder
    const { nodes, edges } = await loadAndParseDot('../callgraph_folders.dot');

    const margin = { top: 150, right: 20, bottom: 20, left: 150 };
    const cellSize = 12; // Controls visual size per function square
    const width = nodes.length * cellSize;
    const height = nodes.length * cellSize;

    const svg = d3.select("#matrix-svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const tooltip = d3.select("#tooltip");

    // 2. Prepare 2D Matrix structure
    const matrix = [];
    const idToIndex = new Map(nodes.map((d, i) => [d.id, i]));

    nodes.forEach((node, i) => {
        node.count = 0;
        node.index = i;
        // Pre-fill zeros
        matrix[i] = d3.range(nodes.length).map(j => ({ x: j, y: i, z: 0 }));
    });

    // Populate matrix counts based on calls
    edges.forEach(edge => {
        const sourceIndex = idToIndex.get(edge.source);
        const targetIndex = idToIndex.get(edge.target);
        if (sourceIndex !== undefined && targetIndex !== undefined) {
            matrix[sourceIndex][targetIndex].z += 1;
            nodes[sourceIndex].count += 1;
            nodes[targetIndex].count += 1;
        }
    });

    // 3. Scale and Group Definitions
    const color = d3.scaleOrdinal(d3.schemeCategory10).domain(nodes.map(d => d.group));

    // --- NEW: Traveling Salesperson Problem (TSP) Heuristic ---
    function getTSPOrder() {
        const unvisited = new Set(d3.range(nodes.length));
        const path = [];

        if (nodes.length === 0) return path;

        // Start the path at node index 0
        let current = 0;
        path.push(current);
        unvisited.delete(current);

        while(unvisited.size > 0) {
            let bestNext = -1;
            let minCost = Infinity;

            for (let next of unvisited) {
                // Core TSP Trick: Low cost (1) for same color, massive penalty (1000) for switching
                let cost = (nodes[current].group === nodes[next].group) ? 1 : 1000;

                // Tie-breaker: If nodes actually call each other, slightly reduce the cost.
                // This ensures nodes within the same color cluster group logically
                // around the diagonal instead of randomly.
                if (matrix[current][next].z > 0 || matrix[next][current].z > 0) {
                    cost -= 0.5;
                }

                if (cost < minCost) {
                    minCost = cost;
                    bestNext = next;
                }
            }

            // Move to the nearest valid neighbor
            current = bestNext;
            path.push(current);
            unvisited.delete(current);
        }
        return path;
    }

    function getRCMOrder() {
        if (nodes.length === 0) return [];

        const numNodes = nodes.length;
        // 1. Build an adjacency list and count degrees
        const adj = new Array(numNodes).fill(0).map(() => []);
        const degree = new Uint32Array(numNodes);

        // Map string IDs to indices for fast lookup
        const idToIndex = new Map(nodes.map((d, i) => [d.id, i]));

        edges.forEach(edge => {
            const u = idToIndex.get(edge.source);
            const v = idToIndex.get(edge.target);

            if (u !== undefined && v !== undefined && u !== v) {
                adj[u].push(v);
                adj[v].push(u); // RCM treats graphs as undirected to cluster related nodes
                degree[u]++;
                degree[v]++;
            }
        });

        // 2. Sort each node's neighbors by their degree (ascending)
        // This is the "secret sauce" of Cuthill-McKee
        for (let i = 0; i < numNodes; i++) {
            adj[i].sort((a, b) => degree[a] - degree[b]);
        }

        // 3. Breadth-First Search (BFS)
        const result = [];
        const visited = new Uint8Array(numNodes); // Typed array for ultra-fast checks

        // We loop to ensure we catch disconnected islands/clusters in the graph
        for (let i = 0; i < numNodes; i++) {
            if (!visited[i]) {
                const queue = [i];
                visited[i] = 1;

                let head = 0; // Avoid Array.shift() performance penalty on large arrays
                while (head < queue.length) {
                    const current = queue[head++];
                    result.push(current);

                    for (let neighbor of adj[current]) {
                        if (!visited[neighbor]) {
                            visited[neighbor] = 1;
                            queue.push(neighbor);
                        }
                    }
                }
            }
        }

        // 4. Reverse the result (The 'R' in RCM)
        // Reversing mathematically minimizes the envelope size of the matrix
        return result.reverse();
    }

    const orders = {
        name: d3.range(nodes.length).sort((a, b) => d3.ascending(nodes[a].name, nodes[b].name)),
        count: d3.range(nodes.length).sort((a, b) => nodes[b].count - nodes[a].count),
        group: d3.range(nodes.length).sort((a, b) => {
            const diff = d3.ascending(nodes[a].group, nodes[b].group);
            return diff !== 0 ? diff : d3.ascending(nodes[a].name, nodes[b].name);
        }),
        tsp: getTSPOrder(),
        rcm: getRCMOrder()
    };

    let x = d3.scaleBand().range([0, width]).domain(orders.name);
    let y = d3.scaleBand().range([0, height]).domain(orders.name);

    // 4. Draw Rows & Cells
    const row = svg.selectAll(".row")
        .data(matrix)
        .join("g")
        .attr("class", "row")
        .attr("transform", (d, i) => `translate(0,${y(i)})`);

    row.selectAll(".cell")
        .data(d => d.filter(item => item.z > 0)) // performance optimization: don't draw empty squares
        .join("rect")
        .attr("class", "cell")
        .attr("x", d => x(d.x))
        .attr("width", x.bandwidth())
        .attr("height", y.bandwidth())
        .style("fill", d => color(nodes[d.x].group))
        .on("mouseover", function(event, d) {
            d3.select(this).style("fill", "#ff0000"); // highlight red
            tooltip.transition().duration(200).style("opacity", 1);
            tooltip.html(`
                <strong>Caller:</strong> ${nodes[d.y].fullName}<br/>
                <strong>Callee:</strong> ${nodes[d.x].fullName}<br/>
                <strong>Calls:</strong> ${d.z}
            `)
                .style("left", (event.pageX + 15) + "px")
                .style("top", (event.pageY - 28) + "px");
        })
        .on("mouseout", function(event, d) {
            d3.select(this).style("fill", color(nodes[d.x].group)); // return to original category color
            tooltip.transition().duration(300).style("opacity", 0);
        });

    // Row Labels (Y-Axis)
    row.append("text")
        .attr("class", "label")
        .attr("x", -6)
        .attr("y", x.bandwidth() / 2)
        .attr("dy", ".32em")
        .attr("text-anchor", "end")
        .text((d, i) => nodes[i].name)
        .style("fill", (d, i) => color(nodes[i].group));

    // Draw Columns (X-Axis Labels)
    const column = svg.selectAll(".column")
        .data(matrix)
        .join("g")
        .attr("class", "column")
        .attr("transform", (d, i) => `translate(${x(i)},0)rotate(-90)`);

    column.append("text")
        .attr("class", "label")
        .attr("x", 6)
        .attr("y", y.bandwidth() / 2)
        .attr("dy", ".32em")
        .attr("text-anchor", "start")
        .text((d, i) => nodes[i].name)
        .style("fill", (d, i) => color(nodes[i].group));

    // 5. Update listener for ordering
    d3.select("#order").on("change", function() {
        const currentOrder = orders[this.value];
        x.domain(currentOrder);
        y.domain(currentOrder);

        const t = svg.transition().duration(750);

        row.transition(t)
            .attr("transform", (d, i) => `translate(0,${y(i)})`)
            .selectAll(".cell")
            .attr("x", d => x(d.x));

        column.transition(t)
            .attr("transform", (d, i) => `translate(${x(i)},0)rotate(-90)`);
    });
}

// Start
drawMatrix();