function renderGraph(levels, depthById, nodes, edges) {
    container.selectAll("*").remove();

    const nodeData = [];
    let maxLineLength = 0;
    let maxLines = 1;

    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const lines = rawLabel.split("\\n");
            lines.forEach((line) => {
                maxLineLength = Math.max(maxLineLength, line.length);
            });
            maxLines = Math.max(maxLines, lines.length);
            nodeData.push({ id, depth, rawLabel, lines });
        });
    });

    const nodeWidth = Math.max(200, maxLineLength * 7 + 24);
    const nodeHeight = Math.max(42, maxLines * 16 + 18);
    const xSpacing = nodeWidth + 40;
    const ySpacing = nodeHeight + 70;
    const margin = { top: 30, right: 30, bottom: 30, left: 30 };
    const uniqueFiles = new Set();
    levels.forEach((levelIds) => {
        levelIds.forEach((id) => {
            const filename = getNodeFile(id, nodes);
            uniqueFiles.add(filename);
        });
    });

    const filesArray = Array.from(uniqueFiles);
    const { fileOrder, nodeOrderByFileDepth } = optimizeLayout(
        levels,
        depthById,
        nodes,
        edges,
        filesArray
    );
    const maxNodesPerLevelByFile = new Map();
    fileOrder.forEach((f) => maxNodesPerLevelByFile.set(f, 0));

    levels.forEach((levelIds) => {
        const counts = new Map();
        levelIds.forEach((id) => {
            const filename = getNodeFile(id, nodes);
            counts.set(filename, (counts.get(filename) || 0) + 1);
        });
        for (const [f, c] of counts.entries()) {
            if (c > maxNodesPerLevelByFile.get(f)) {
                maxNodesPerLevelByFile.set(f, c);
            }
        }
    });

    const fileStartX = new Map();
    let currentX = margin.left;
    fileOrder.forEach((f) => {
        fileStartX.set(f, currentX);
        const colWidth = maxNodesPerLevelByFile.get(f) * xSpacing;
        currentX += colWidth;
    });

    const svgWidth = Math.max(900, currentX + margin.right);
    const svgHeight =
        margin.top + margin.bottom + (levels.length - 1) * ySpacing + nodeHeight;

    const positions = new Map();

    levels.forEach((_, depth) => {
        fileOrder.forEach((f) => {
            const depthMap = nodeOrderByFileDepth.get(f);
            const ids = depthMap ? depthMap.get(depth) : null;
            if (!ids || ids.length === 0) {
                return;
            }
            const startX = fileStartX.get(f);
            const N = maxNodesPerLevelByFile.get(f);
            const K = ids.length;

            const colCenter = startX + N * xSpacing / 2;
            const firstNodeCenterX = colCenter - (K - 1) * xSpacing / 2;

            ids.forEach((id, index) => {
                const x = firstNodeCenterX + index * xSpacing;
                const y = margin.top + nodeHeight / 2 + depth * ySpacing;
                positions.set(id, { x, y });
            });
        });
    });

    const linkData = [];
    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= MAX_DEPTH) {
            continue;
        }
        const sourcePos = positions.get(from);
        if (!sourcePos) {
            continue;
        }
        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) {
                continue;
            }
            const targetPos = positions.get(target);
            if (!targetPos) {
                continue;
            }
            linkData.push({ source: sourcePos, target: targetPos });
        }
    }

    const svg = container
        .append("svg")
        .attr("width", svgWidth)
        .attr("height", svgHeight);

    // Compute and draw bounding boxes
    const fileBoxes = new Map();
    fileOrder.forEach((f) => {
        fileBoxes.set(f, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, active: false });
    });

    nodeData.forEach(d => {
        const filename = d.rawLabel.split("\\n")[0];
        const pos = positions.get(d.id);
        const box = fileBoxes.get(filename);
        box.active = true;
        box.minX = Math.min(box.minX, pos.x - nodeWidth / 2);
        box.maxX = Math.max(box.maxX, pos.x + nodeWidth / 2);
        box.minY = Math.min(box.minY, pos.y - nodeHeight / 2);
        box.maxY = Math.max(box.maxY, pos.y + nodeHeight / 2);
    });

    const boxPadding = 20;
    const boxData = [];
    const colorScale = d3.scaleOrdinal(d3.schemeCategory10);
    
    fileOrder.forEach((f, i) => {
        const box = fileBoxes.get(f);
        if (box.active) {
            boxData.push({
                file: f,
                x: box.minX - boxPadding,
                y: box.minY - boxPadding,
                width: box.maxX - box.minX + 2 * boxPadding,
                height: box.maxY - box.minY + 2 * boxPadding,
                color: colorScale(i)
            });
        }
    });

    const boxesGroup = svg.append("g").attr("class", "bounding-boxes");
    
    boxesGroup.selectAll("rect")
        .data(boxData)
        .enter()
        .append("rect")
        .attr("x", d => d.x)
        .attr("y", d => d.y)
        .attr("width", d => d.width)
        .attr("height", d => d.height)
        .attr("fill", d => d.color)
        .attr("fill-opacity", 0.08)
        .attr("stroke", d => d.color)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,5")
        .attr("rx", 10);
        
    boxesGroup.selectAll("text.box-label")
        .data(boxData)
        .enter()
        .append("text")
        .attr("class", "box-label")
        .attr("x", d => d.x + 10)
        .attr("y", d => d.y + 20)
        .attr("fill", d => d.color)
        .style("font-weight", "bold")
        .style("font-size", "14px")
        .text(d => d.file);

    svg.append("g").attr("class", "level-lines")
        .selectAll("line")
        .data(levels)
        .enter()
        .append("line")
        .attr("x1", margin.left)
        .attr("x2", svgWidth - margin.right)
        .attr(
            "y1",
            (_, depth) => margin.top + nodeHeight / 2 + depth * ySpacing
        )
        .attr(
            "y2",
            (_, depth) => margin.top + nodeHeight / 2 + depth * ySpacing
        )
        .attr("stroke", "#e2e8f0")
        .attr("stroke-width", 1);

    svg.append("g").attr("class", "edges")
        .selectAll("line")
        .data(linkData)
        .enter()
        .append("line")
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y + nodeHeight / 2)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y - nodeHeight / 2)
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 1);

    const nodeGroups = svg
        .append("g").attr("class", "nodes")
        .selectAll("g")
        .data(nodeData)
        .enter()
        .append("g")
        .attr("transform", (d) => {
            const position = positions.get(d.id);
            return `translate(${position.x - nodeWidth / 2}, ${
                position.y - nodeHeight / 2
            })`;
        });

    nodeGroups
        .append("rect")
        .attr("width", nodeWidth)
        .attr("height", nodeHeight)
        .attr("rx", 8)
        .attr("fill", (d) => (d.depth === 0 ? "#2563eb" : "#e2e8f0"))
        .attr("stroke", "#94a3b8");

    nodeGroups
        .append("text")
        .attr("x", nodeWidth / 2)
        .attr("y", nodeHeight / 2 - (maxLines - 1) * 8)
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .attr("fill", (d) => (d.depth === 0 ? "#f8fafc" : "#1f2937"))
        .selectAll("tspan")
        .data((d) => d.lines)
        .enter()
        .append("tspan")
        .attr("x", nodeWidth / 2)
        .attr("dy", (_, i) => (i === 0 ? 0 : 16))
        .text((d) => d);
}

function renderError(message) {
    container.selectAll("*").remove();
    container
        .append("div")
        .style("color", "#b91c1c")
        .style("font-weight", "600")
        .text(message);
}
