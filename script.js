const ROOT_LABEL = "icon.f90\\n__MAIN__";
const MAX_DEPTH = 3;

const container = d3.select("#visualization");

function parseDot(dotText) {
    const nodes = new Map();
    const edges = new Map();
    const lines = dotText.split(/\r?\n/);
    let currentNodeId = null;

    for (const line of lines) {
        const edgeMatch = line.match(/^\s*(node\d+)\s*->\s*(node\d+)/);
        if (edgeMatch) {
            const from = edgeMatch[1];
            const to = edgeMatch[2];
            if (!edges.has(from)) {
                edges.set(from, new Set());
            }
            edges.get(from).add(to);
            continue;
        }

        const nodeStart = line.match(/^\s*(node\d+)\s*\[/);
        if (nodeStart) {
            currentNodeId = nodeStart[1];
        }

        if (currentNodeId) {
            const labelMatch = line.match(/label="([^"]+)"/);
            if (labelMatch) {
                nodes.set(currentNodeId, labelMatch[1]);
            }
            if (line.includes("];")) {
                currentNodeId = null;
            }
        }
    }

    return { nodes, edges };
}

function buildLevels(rootId, edges) {
    const levels = Array.from({ length: MAX_DEPTH + 1 }, () => []);
    const depthById = new Map();
    const queue = [rootId];

    levels[0].push(rootId);
    depthById.set(rootId, 0);

    while (queue.length) {
        const current = queue.shift();
        const depth = depthById.get(current);
        if (depth === MAX_DEPTH) {
            continue;
        }
        const neighbors = edges.get(current);
        if (!neighbors) {
            continue;
        }
        for (const neighbor of neighbors) {
            if (depthById.has(neighbor)) {
                continue;
            }
            depthById.set(neighbor, depth + 1);
            levels[depth + 1].push(neighbor);
            queue.push(neighbor);
        }
    }

    return { levels, depthById };
}

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
            const rawLabel = nodes.get(id) || id;
            const filename = rawLabel.split("\\n")[0];
            uniqueFiles.add(filename);
        });
    });

    let filesArray = Array.from(uniqueFiles);
    const maxNodesPerLevelByFile = new Map();
    filesArray.forEach((f) => maxNodesPerLevelByFile.set(f, 0));

    levels.forEach((levelIds) => {
        const counts = new Map();
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const filename = rawLabel.split("\\n")[0];
            counts.set(filename, (counts.get(filename) || 0) + 1);
        });
        for (const [f, c] of counts.entries()) {
            if (c > maxNodesPerLevelByFile.get(f)) {
                maxNodesPerLevelByFile.set(f, c);
            }
        }
    });

    let levelNodes = [];
    levels.forEach((levelIds) => {
        const nodesByFile = new Map();
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const filename = rawLabel.split("\\n")[0];
            if (!nodesByFile.has(filename)) nodesByFile.set(filename, []);
            nodesByFile.get(filename).push(id);
        });
        levelNodes.push(nodesByFile);
    });

    function getX(id, depth, currentFiles, currentNodes) {
        const rawLabel = nodes.get(id) || id;
        const filename = rawLabel.split("\\n")[0];
        let startX = 0;
        for (const f of currentFiles) {
            if (f === filename) break;
            startX += maxNodesPerLevelByFile.get(f) * xSpacing;
        }
        const arr = currentNodes[depth].get(filename);
        if (!arr) return 0;
        const index = arr.indexOf(id);
        const N = maxNodesPerLevelByFile.get(filename);
        const K = arr.length;
        const colCenter = startX + N * xSpacing / 2;
        return colCenter - (K - 1) * xSpacing / 2 + index * xSpacing;
    }

    function countCrossings(currentFiles, currentNodes) {
        let crossings = 0;
        const xCoords = new Map();
        for (let depth = 0; depth < levels.length; depth++) {
            for (const id of levels[depth]) {
                xCoords.set(id, getX(id, depth, currentFiles, currentNodes));
            }
        }

        for (let depth = 0; depth < levels.length - 1; depth++) {
            const levelEdges = [];
            for (const u of levels[depth]) {
                const targets = edges.get(u);
                if (targets) {
                    for (const v of targets) {
                        if (depthById.get(v) === depth + 1) {
                            levelEdges.push({ u, v });
                        }
                    }
                }
            }
            for (let i = 0; i < levelEdges.length; i++) {
                const u1X = xCoords.get(levelEdges[i].u);
                const v1X = xCoords.get(levelEdges[i].v);
                for (let j = i + 1; j < levelEdges.length; j++) {
                    const u2X = xCoords.get(levelEdges[j].u);
                    const v2X = xCoords.get(levelEdges[j].v);
                    if ((u1X - u2X) * (v1X - v2X) < 0) {
                        crossings++;
                    }
                }
            }
        }
        return crossings;
    }

    let currentCost = countCrossings(filesArray, levelNodes);
    let bestCost = currentCost;
    let bestFiles = [...filesArray];
    let bestNodes = levelNodes.map(m => new Map([...m].map(([k,v]) => [k, [...v]])));

    let T = 100.0;
    while (T > 0.1) {
        for (let iter = 0; iter < 50; iter++) {
            const moveType = Math.random() < 0.5 ? 1 : 2;
            const nextFiles = [...filesArray];
            const nextNodes = levelNodes.map(m => new Map([...m].map(([k,v]) => [k, [...v]])));
            let valid = false;

            if (moveType === 1) {
                const cands = [];
                for (let d = 0; d < nextNodes.length; d++) {
                    for (const [f, arr] of nextNodes[d].entries()) {
                        if (arr.length >= 2) cands.push({ d, f, arr });
                    }
                }
                if (cands.length > 0) {
                    const cand = cands[Math.floor(Math.random() * cands.length)];
                    const arr = nextNodes[cand.d].get(cand.f);
                    const i1 = Math.floor(Math.random() * arr.length);
                    let i2 = Math.floor(Math.random() * arr.length);
                    while (i1 === i2) i2 = Math.floor(Math.random() * arr.length);
                    [arr[i1], arr[i2]] = [arr[i2], arr[i1]];
                    valid = true;
                }
            } else {
                if (nextFiles.length >= 2) {
                    const i1 = Math.floor(Math.random() * nextFiles.length);
                    let i2 = Math.floor(Math.random() * nextFiles.length);
                    while (i1 === i2) i2 = Math.floor(Math.random() * nextFiles.length);
                    [nextFiles[i1], nextFiles[i2]] = [nextFiles[i2], nextFiles[i1]];
                    valid = true;
                }
            }

            if (valid) {
                const nextCost = countCrossings(nextFiles, nextNodes);
                if (nextCost < currentCost || Math.random() < Math.exp((currentCost - nextCost) / T)) {
                    filesArray = nextFiles;
                    levelNodes = nextNodes;
                    currentCost = nextCost;
                    if (currentCost < bestCost) {
                        bestCost = currentCost;
                        bestFiles = [...filesArray];
                        bestNodes = levelNodes.map(m => new Map([...m].map(([k,v]) => [k, [...v]])));
                    }
                }
            }
        }
        T *= 0.9;
    }

    filesArray = bestFiles;
    levelNodes = bestNodes;

    const fileStartX = new Map();
    let currentX = margin.left;
    filesArray.forEach((f) => {
        fileStartX.set(f, currentX);
        const colWidth = maxNodesPerLevelByFile.get(f) * xSpacing;
        currentX += colWidth;
    });

    const svgWidth = Math.max(900, currentX + margin.right);
    const svgHeight =
        margin.top + margin.bottom + (levels.length - 1) * ySpacing + nodeHeight;

    const positions = new Map();

    levels.forEach((levelIds, depth) => {
        const nodesByFile = levelNodes[depth];

        for (const [f, ids] of nodesByFile.entries()) {
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
        }
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
    filesArray.forEach((f) => {
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
    
    filesArray.forEach((f, i) => {
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

fetch("callgraph.dot")
    .then((response) => {
        if (!response.ok) {
            throw new Error("Unable to load callgraph.dot");
        }
        return response.text();
    })
    .then((dotText) => {
        const { nodes, edges } = parseDot(dotText);
        let rootId = null;
        for (const [id, label] of nodes.entries()) {
            if (label === ROOT_LABEL) {
                rootId = id;
                break;
            }
        }
        if (!rootId) {
            renderError("Could not find icon.f90\\n__MAIN__ in callgraph.dot.");
            return;
        }

        const { levels, depthById } = buildLevels(rootId, edges);
        renderGraph(levels, depthById, nodes, edges);
    })
    .catch((error) => {
        renderError(error.message);
    });

const toggleEdges = document.getElementById("toggle-edges");
if (toggleEdges) {
    toggleEdges.addEventListener("change", (e) => {
        d3.selectAll(".edges").style("display", e.target.checked ? "block" : "none");
    });
}

const toggleBoxes = document.getElementById("toggle-boxes");
if (toggleBoxes) {
    toggleBoxes.addEventListener("change", (e) => {
        d3.selectAll(".bounding-boxes").style("display", e.target.checked ? "block" : "none");
    });
}
