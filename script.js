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

function getNodeFile(id, nodes) {
    const rawLabel = nodes.get(id) || id;
    return rawLabel.split("\\n")[0];
}

function buildInitialLayout(levels, nodes, filesArray) {
    const nodeOrderByFileDepth = new Map();
    filesArray.forEach((f) => nodeOrderByFileDepth.set(f, new Map()));

    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const filename = getNodeFile(id, nodes);
            const depthMap = nodeOrderByFileDepth.get(filename);
            if (!depthMap.has(depth)) {
                depthMap.set(depth, []);
            }
            depthMap.get(depth).push(id);
        });
    });

    return { fileOrder: filesArray.slice(), nodeOrderByFileDepth };
}

function buildEdgesByDepth(edges, depthById) {
    const edgesByDepth = new Map();
    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= MAX_DEPTH) {
            continue;
        }
        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) {
                continue;
            }
            if (!edgesByDepth.has(fromDepth)) {
                edgesByDepth.set(fromDepth, []);
            }
            edgesByDepth.get(fromDepth).push([from, target]);
        }
    }
    return edgesByDepth;
}

function buildIndexByDepth(levels, fileOrder, nodeOrderByFileDepth) {
    const indexByDepth = new Map();
    levels.forEach((_, depth) => {
        const map = new Map();
        let index = 0;
        fileOrder.forEach((file) => {
            const depthMap = nodeOrderByFileDepth.get(file);
            const ids = depthMap ? depthMap.get(depth) : null;
            if (!ids || ids.length === 0) {
                return;
            }
            ids.forEach((id) => {
                map.set(id, index);
                index += 1;
            });
        });
        indexByDepth.set(depth, map);
    });
    return indexByDepth;
}

function fenwickAdd(bit, index, delta) {
    for (let i = index; i < bit.length; i += i & -i) {
        bit[i] += delta;
    }
}

function fenwickSum(bit, index) {
    let sum = 0;
    for (let i = index; i > 0; i -= i & -i) {
        sum += bit[i];
    }
    return sum;
}

function countCrossingsForLayer(edgesLayer, sourceIndex, targetIndex) {
    const pairs = [];
    for (const [from, to] of edgesLayer) {
        const s = sourceIndex.get(from);
        const t = targetIndex.get(to);
        if (s === undefined || t === undefined) {
            continue;
        }
        pairs.push([s, t]);
    }
    if (pairs.length < 2) {
        return 0;
    }
    pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const maxIndex = targetIndex.size;
    if (maxIndex <= 1) {
        return 0;
    }
    const bit = new Array(maxIndex + 1).fill(0);
    let inversions = 0;
    let seen = 0;
    for (const pair of pairs) {
        const t = pair[1] + 1;
        const lessOrEqual = fenwickSum(bit, t);
        inversions += seen - lessOrEqual;
        fenwickAdd(bit, t, 1);
        seen += 1;
    }
    return inversions;
}

function countCrossings(levels, edgesByDepth, fileOrder, nodeOrderByFileDepth) {
    const indexByDepth = buildIndexByDepth(levels, fileOrder, nodeOrderByFileDepth);
    let total = 0;
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
        const edgesLayer = edgesByDepth.get(depth);
        if (!edgesLayer || edgesLayer.length < 2) {
            continue;
        }
        const sourceIndex = indexByDepth.get(depth);
        const targetIndex = indexByDepth.get(depth + 1);
        if (!sourceIndex || !targetIndex) {
            continue;
        }
        total += countCrossingsForLayer(edgesLayer, sourceIndex, targetIndex);
    }
    return total;
}

function cloneNodeOrder(nodeOrderByFileDepth) {
    const clone = new Map();
    for (const [file, depthMap] of nodeOrderByFileDepth.entries()) {
        const depthClone = new Map();
        for (const [depth, ids] of depthMap.entries()) {
            depthClone.set(depth, ids.slice());
        }
        clone.set(file, depthClone);
    }
    return clone;
}

function optimizeLayout(levels, depthById, nodes, edges, filesArray) {
    const { fileOrder, nodeOrderByFileDepth } = buildInitialLayout(levels, nodes, filesArray);
    const edgesByDepth = buildEdgesByDepth(edges, depthById);
    let currentCrossings = countCrossings(levels, edgesByDepth, fileOrder, nodeOrderByFileDepth);
    if (currentCrossings === 0) {
        return { fileOrder, nodeOrderByFileDepth };
    }

    const totalNodes = levels.reduce((acc, level) => acc + level.length, 0);
    const iterations = Math.min(5000, Math.max(1500, totalNodes * 30));
    const initialTemp = Math.max(1, currentCrossings * 0.25);
    const cooling = 0.995;

    const swapCandidates = [];
    for (const [file, depthMap] of nodeOrderByFileDepth.entries()) {
        for (const [depth, ids] of depthMap.entries()) {
            if (ids.length >= 2) {
                swapCandidates.push({ file, depth });
            }
        }
    }

    const hasNodeSwap = swapCandidates.length > 0;
    const hasFileSwap = fileOrder.length >= 2;
    if (!hasNodeSwap && !hasFileSwap) {
        return { fileOrder, nodeOrderByFileDepth };
    }

    let bestCrossings = currentCrossings;
    let bestFileOrder = fileOrder.slice();
    let bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);

    for (let i = 0; i < iterations; i += 1) {
        const temperature = Math.max(0.001, initialTemp * Math.pow(cooling, i));
        let moveType = "nodeSwap";
        if (!hasNodeSwap) {
            moveType = "fileSwap";
        } else if (!hasFileSwap) {
            moveType = "nodeSwap";
        } else if (Math.random() < 0.3) {
            moveType = "fileSwap";
        }

        if (moveType === "nodeSwap") {
            const pick = swapCandidates[Math.floor(Math.random() * swapCandidates.length)];
            const depthMap = nodeOrderByFileDepth.get(pick.file);
            const ids = depthMap.get(pick.depth);
            const a = Math.floor(Math.random() * ids.length);
            let b = Math.floor(Math.random() * ids.length);
            while (b === a) {
                b = Math.floor(Math.random() * ids.length);
            }
            const tmp = ids[a];
            ids[a] = ids[b];
            ids[b] = tmp;

            const newCrossings = countCrossings(levels, edgesByDepth, fileOrder, nodeOrderByFileDepth);
            const accept =
                newCrossings < currentCrossings ||
                Math.random() < Math.exp((currentCrossings - newCrossings) / temperature);
            if (accept) {
                currentCrossings = newCrossings;
                if (newCrossings < bestCrossings) {
                    bestCrossings = newCrossings;
                    bestFileOrder = fileOrder.slice();
                    bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);
                }
            } else {
                const revert = ids[a];
                ids[a] = ids[b];
                ids[b] = revert;
            }
        } else {
            const a = Math.floor(Math.random() * fileOrder.length);
            let b = Math.floor(Math.random() * fileOrder.length);
            while (b === a) {
                b = Math.floor(Math.random() * fileOrder.length);
            }
            const tmp = fileOrder[a];
            fileOrder[a] = fileOrder[b];
            fileOrder[b] = tmp;

            const newCrossings = countCrossings(levels, edgesByDepth, fileOrder, nodeOrderByFileDepth);
            const accept =
                newCrossings < currentCrossings ||
                Math.random() < Math.exp((currentCrossings - newCrossings) / temperature);
            if (accept) {
                currentCrossings = newCrossings;
                if (newCrossings < bestCrossings) {
                    bestCrossings = newCrossings;
                    bestFileOrder = fileOrder.slice();
                    bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);
                }
            } else {
                const revert = fileOrder[a];
                fileOrder[a] = fileOrder[b];
                fileOrder[b] = revert;
            }
        }
    }

    return { fileOrder: bestFileOrder, nodeOrderByFileDepth: bestNodeOrder };
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
