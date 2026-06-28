function renderGraph(levels, depthById, nodes, edges) {
    container.selectAll("*").remove();

    const nodeData = [];
    const basePaddingX = 16;
    const basePaddingY = 12;
    const charWidthEstimate = 6.5;
    const lineHeight = 16;
    const xSpacingBetweenNodes = 30;
    const defaultYSpacing = 160;
    const minLaneGap = 4; // Guarantees at least 4 pixels of height between orthogonal edge layers
    const margin = { top: 60, right: 60, bottom: 60, left: 60 };

    // 1. Process node data and compute individual dimensions per node
    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const labelInfo = parseNodeLabel(rawLabel);
            const lines = labelInfo.lines;

            let localMaxLineLength = 0;
            lines.forEach((line) => {
                localMaxLineLength = Math.max(localMaxLineLength, line.length);
            });

            const calculatedWidth = Math.max(32, localMaxLineLength * charWidthEstimate + basePaddingX);
            const calculatedHeight = Math.max(24, lines.length * lineHeight + basePaddingY);

            nodeData.push({
                id,
                depth,
                rawLabel,
                lines,
                width: calculatedWidth,
                height: calculatedHeight,
                folder: labelInfo.folder,
                file: labelInfo.file,
                fileKey: makeFileKey(labelInfo.folder, labelInfo.file)
            });
        });
    });

    const nodeDims = new Map(nodeData.map(d => [d.id, { w: d.width, h: d.height }]));

    const { folderOrder, fileOrderByFolder, fileMetaByKey } = buildFolderFileIndex(levels, nodes);
    const { folderOrder: orderedFolders, fileOrderByFolder: orderedFilesByFolder, nodeOrderByFileDepth } =
        optimizeLayout(levels, depthById, nodes, edges, folderOrder, fileOrderByFolder);
    const fileOrder = flattenFileOrder(orderedFolders, orderedFilesByFolder);

    // 2. Compute maximum column widths per file column
    const maxNodesPerLevelByFile = new Map();
    const fileColumnWidths = new Map();

    fileOrder.forEach((f) => {
        maxNodesPerLevelByFile.set(f, 0);
        fileColumnWidths.set(f, 0);
    });

    levels.forEach((levelIds) => {
        const counts = new Map();
        const maxNodeWidthInFileForLevel = new Map();

        levelIds.forEach((id) => {
            const fileKey = getNodeFileKey(id, nodes);
            counts.set(fileKey, (counts.get(fileKey) || 0) + 1);

            const dims = nodeDims.get(id);
            if (dims) {
                const currentMax = maxNodeWidthInFileForLevel.get(fileKey) || 0;
                maxNodeWidthInFileForLevel.set(fileKey, Math.max(currentMax, dims.w));
            }
        });

        for (const [f, c] of counts.entries()) {
            maxNodesPerLevelByFile.set(f, Math.max(maxNodesPerLevelByFile.get(f) || 0, c));
            const levelNodeWidth = maxNodeWidthInFileForLevel.get(f) || 32;
            const totalLevelWidthNeeded = c * levelNodeWidth + (c - 1) * xSpacingBetweenNodes;
            fileColumnWidths.set(f, Math.max(fileColumnWidths.get(f) || 0, totalLevelWidthNeeded));
        }
    });

    // 3. Calculate file X start boundaries dynamically
    const fileStartX = new Map();
    let currentX = margin.left;
    orderedFolders.forEach((folder) => {
        const files = orderedFilesByFolder.get(folder) || [];
        files.forEach((f) => {
            fileStartX.set(f, currentX);
            const colWidth = fileColumnWidths.get(f) + 40;
            currentX += colWidth;
        });
    });

    const svgWidth = Math.max(900, currentX + margin.right);
    const positionsX = new Map();

    // 4. Pre-calculate strictly X positions first
    levels.forEach((_, depth) => {
        orderedFolders.forEach((folder) => {
            const files = orderedFilesByFolder.get(folder) || [];
            files.forEach((f) => {
                const depthMap = nodeOrderByFileDepth.get(f);
                const ids = depthMap ? depthMap.get(depth) : null;
                if (!ids || ids.length === 0) return;

                const startX = fileStartX.get(f);
                const totalColWidth = fileColumnWidths.get(f);
                const colCenter = startX + totalColWidth / 2;

                const K = ids.length;
                let totalSubsegmentWidth = 0;
                ids.forEach((id) => { totalSubsegmentWidth += nodeDims.get(id).w; });
                totalSubsegmentWidth += (K - 1) * xSpacingBetweenNodes;

                let segmentStartX = colCenter - totalSubsegmentWidth / 2;

                ids.forEach((id) => {
                    const dims = nodeDims.get(id);
                    const x = segmentStartX + dims.w / 2;
                    positionsX.set(id, x);
                    segmentStartX += dims.w + xSpacingBetweenNodes;
                });
            });
        });
    });

    // 5. Generate links and perform Interval Graph Coloring with known X intervals
    const linkData = [];
    const layersEdges = Array.from({ length: MAX_DEPTH }, () => []);

    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= MAX_DEPTH) continue;
        const sourceX = positionsX.get(from);
        if (sourceX === undefined) continue;

        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) continue;
            const targetX = positionsX.get(target);
            if (targetX === undefined) continue;

            const edgeObj = {
                fromId: from,
                toId: target,
                fromDepth: fromDepth,
                leftX: Math.min(sourceX, targetX),
                rightX: Math.max(sourceX, targetX),
                lane: 0
            };
            linkData.push(edgeObj);
            layersEdges[fromDepth].push(edgeObj);
        }
    }

    const maxLanesPerLayer = new Array(MAX_DEPTH).fill(0);

    // Greedy Interval Graph Coloring for Bus Routing (Group by Source Node)
    layersEdges.forEach((layer, depth) => {
        if (layer.length === 0) return;

        // 1. Group edges into buses by fromId
        const buses = new Map();
        layer.forEach((edge) => {
            if (!buses.has(edge.fromId)) {
                buses.set(edge.fromId, {
                    fromId: edge.fromId,
                    leftX: edge.leftX,
                    rightX: edge.rightX,
                    edges: []
                });
            }
            const bus = buses.get(edge.fromId);
            bus.leftX = Math.min(bus.leftX, edge.leftX);
            bus.rightX = Math.max(bus.rightX, edge.rightX);
            bus.edges.push(edge);
        });

        const busArray = Array.from(buses.values());
        busArray.sort((a, b) => a.leftX - b.leftX);

        // 2. Assign lanes to buses
        busArray.forEach((bus, index) => {
            const assignedLanes = [];
            for (let i = 0; i < index; i++) {
                const prev = busArray[i];
                // Intervals overlap if bounds touch or cross
                if (Math.max(bus.leftX, prev.leftX) <= Math.min(bus.rightX, prev.rightX)) {
                    assignedLanes.push(prev.lane);
                }
            }
            let lane = 0;
            while (assignedLanes.includes(lane)) {
                lane++;
            }
            bus.lane = lane;

            // 3. Apply the shared bus lane to all its edges
            bus.edges.forEach((edge) => {
                edge.lane = lane;
            });
        });

        maxLanesPerLayer[depth] = Math.max(...busArray.map(b => b.lane)) + 1;
        layer.forEach(edge => edge.totalLanesInLayer = maxLanesPerLayer[depth]);
    });


    // 6. Dynamically Calculate Y positions (depths) ensuring minimum height constraint
    const depthY = new Array(levels.length).fill(0);
    let maxIndividualHeight = 24;
    nodeData.forEach(d => { if (d.height > maxIndividualHeight) maxIndividualHeight = d.height; });

    depthY[0] = margin.top + maxIndividualHeight / 2;

    for (let d = 0; d < levels.length - 1; d++) {
        const lanes = maxLanesPerLayer[d] || 1;
        const requiredLaneSpace = lanes * minLaneGap;
        // Expand the Y spacing dynamically if the required lane space demands it
        const ySpacing = Math.max(defaultYSpacing, maxIndividualHeight + requiredLaneSpace + 80);
        depthY[d + 1] = depthY[d] + ySpacing;
    }

    const positions = new Map();
    nodeData.forEach((d) => {
        positions.set(d.id, { x: positionsX.get(d.id), y: depthY[d.depth] });
    });

    // Hydrate link objects with full pos
    linkData.forEach((edge) => {
        edge.source = positions.get(edge.fromId);
        edge.target = positions.get(edge.toId);
    });

    const svgHeightComputed = depthY[levels.length - 1] + maxIndividualHeight / 2 + margin.bottom;

    // Determine viewport dimensions to calculate how far to "zoom out" initially
    const containerNode = container.node();
    const viewportWidth = containerNode.clientWidth || window.innerWidth - 40;
    const viewportHeight = containerNode.clientHeight || 600;

    const svg = container
        .append("svg")
        .attr("width", "100%")
        .attr("height", "100%"); // Let the SVG fill the new 80vh CSS container

    // CRITICAL: We wrap EVERYTHING inside this main group.
    // When the user zooms, we will scale and translate this single group.
    const mainGroup = svg.append("g").attr("class", "main-zoom-group");

    // 7. Compute accurate bounding boxes using exact positions
    const fileBoxes = new Map();
    fileOrder.forEach((f) => {
        fileBoxes.set(f, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, active: false });
    });
    const folderBoxes = new Map();
    orderedFolders.forEach((folder) => {
        folderBoxes.set(folder, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, active: false });
    });

    nodeData.forEach((d) => {
        const pos = positions.get(d.id);
        const fileBox = fileBoxes.get(d.fileKey);
        if (fileBox) {
            fileBox.active = true;
            fileBox.minX = Math.min(fileBox.minX, pos.x - d.width / 2);
            fileBox.maxX = Math.max(fileBox.maxX, pos.x + d.width / 2);
            fileBox.minY = Math.min(fileBox.minY, pos.y - d.height / 2);
            fileBox.maxY = Math.max(fileBox.maxY, pos.y + d.height / 2);
        }

        const folderBox = folderBoxes.get(d.folder);
        if (folderBox) {
            folderBox.active = true;
            folderBox.minX = Math.min(folderBox.minX, pos.x - d.width / 2);
            folderBox.maxX = Math.max(folderBox.maxX, pos.x + d.width / 2);
            folderBox.minY = Math.min(folderBox.minY, pos.y - d.height / 2);
            folderBox.maxY = Math.max(folderBox.maxY, pos.y + d.height / 2);
        }
    });

    const boxPadding = 20;
    const fileBoxData = [];
    const folderBoxData = [];
    const fileColorScale = d3.scaleOrdinal(d3.schemeCategory10);
    const folderColorScale = d3.scaleOrdinal(d3.schemeSet3);

    orderedFolders.forEach((folder, i) => {
        const box = folderBoxes.get(folder);
        if (box.active) {
            folderBoxData.push({
                folder, x: box.minX - boxPadding, y: box.minY - boxPadding,
                width: box.maxX - box.minX + 2 * boxPadding, height: box.maxY - box.minY + 2 * boxPadding,
                color: folderColorScale(i)
            });
        }
    });

    fileOrder.forEach((f, i) => {
        const box = fileBoxes.get(f);
        if (box.active) {
            const meta = fileMetaByKey.get(f);
            const label = meta && meta.file ? meta.file : f;
            fileBoxData.push({
                file: f, label, x: box.minX - boxPadding, y: box.minY - boxPadding,
                width: box.maxX - box.minX + 2 * boxPadding, height: box.maxY - box.minY + 2 * boxPadding,
                color: fileColorScale(i)
            });
        }
    });

    // Render folder boxes
    const folderBoxesGroup = mainGroup.append("g").attr("class", "folder-bounding-boxes");
    folderBoxesGroup.selectAll("rect")
        .data(folderBoxData).enter().append("rect")
        .attr("x", (d) => d.x).attr("y", (d) => d.y)
        .attr("width", (d) => d.width).attr("height", (d) => d.height)
        .attr("fill", (d) => d.color).attr("fill-opacity", 0.05)
        .attr("stroke", (d) => d.color).attr("stroke-width", 2)
        .attr("stroke-dasharray", "8,4").attr("rx", 12);

    folderBoxesGroup.selectAll("text.folder-box-label")
        .data(folderBoxData).enter().append("text")
        .attr("class", "folder-box-label").attr("x", (d) => d.x + 10).attr("y", (d) => d.y + 20)
        .attr("fill", (d) => d.color).style("font-weight", "bold").style("font-size", "14px").text((d) => d.folder);

    // Render file boxes
    const fileBoxesGroup = mainGroup.append("g").attr("class", "file-bounding-boxes");
    fileBoxesGroup.selectAll("rect")
        .data(fileBoxData).enter().append("rect")
        .attr("x", (d) => d.x).attr("y", (d) => d.y)
        .attr("width", (d) => d.width).attr("height", (d) => d.height)
        .attr("fill", (d) => d.color).attr("fill-opacity", 0.08)
        .attr("stroke", (d) => d.color).attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,5").attr("rx", 10);

    fileBoxesGroup.selectAll("text.file-box-label")
        .data(fileBoxData).enter().append("text")
        .attr("class", "file-box-label").attr("x", (d) => d.x + 10).attr("y", (d) => d.y + 34)
        .attr("fill", (d) => d.color).style("font-weight", "bold").style("font-size", "12px").text((d) => d.label);

    // Render baseline depth dividers
    mainGroup.append("g").attr("class", "level-lines")
        .selectAll("line")
        .data(levels).enter().append("line")
        .attr("x1", margin.left).attr("x2", svgWidth - margin.right)
        .attr("y1", (_, depth) => depthY[depth]).attr("y2", (_, depth) => depthY[depth])
        .attr("stroke", "#e2e8f0").attr("stroke-width", 1);

    // 8. Render paths dynamically using computed intervals
    const edgesGroup = mainGroup.append("g").attr("class", "edges");

    const edgesSelection = edgesGroup.selectAll("path")
        .data(linkData).enter().append("path")
        .attr("fill", "none").attr("stroke", "#94a3b8").attr("stroke-width", 1)
        .attr("d", (d) => buildPathLine(d, nodeDims, document.getElementById("toggle-orthogonal")?.checked));

    // Expose layout update context securely for checkboxes
    container.node().updateEdgeRouting = function() {
        const isOrthogonal = document.getElementById("toggle-orthogonal")?.checked;
        edgesSelection.attr("d", (d) => buildPathLine(d, nodeDims, isOrthogonal));
    };

    function buildPathLine(d, nodeDims, useOrthogonal) {
        const hFrom = nodeDims.get(d.fromId).h;
        const hTo = nodeDims.get(d.toId).h;

        const startX = d.source.x;
        const startY = d.source.y + (hFrom / 2);
        const endX = d.target.x;
        const endY = d.target.y - (hTo / 2);

        if (!useOrthogonal) {
            return `M ${startX} ${startY} L ${endX} ${endY}`;
        } else {
            // Using maxIndividualHeight (from outer scope) instead of hTo ensures
            // turnY is perfectly identical for all edges in the same bus, while
            // safely clearing the top of the tallest target node in the layer.
            const verticalGap = (d.target.y - d.source.y) - (hFrom / 2) - (maxIndividualHeight / 2);
            const laneCount = d.totalLanesInLayer || 1;

            // Calculate lane proportionally
            const laneOffset = ((d.lane + 1) / (laneCount + 1)) * verticalGap;
            const turnY = startY + laneOffset;

            // The exact overlapping paths create the visual "bus", dropping only at endX
            return `M ${startX} ${startY} L ${startX} ${turnY} L ${endX} ${turnY} L ${endX} ${endY}`;
        }
    }
    // 9. Render nodes
    const nodesSelection = mainGroup
        .append("g").attr("class", "nodes")
        .selectAll("g")
        .data(nodeData).enter().append("g")
        .attr("transform", (d) => {
            const position = positions.get(d.id);
            return `translate(${position.x - d.width / 2}, ${position.y - d.height / 2})`;
        });

    nodesSelection.append("rect")
        .attr("width", (d) => d.width).attr("height", (d) => d.height)
        .attr("rx", 6).attr("fill", (d) => (d.depth === 0 ? "#2563eb" : "#e2e8f0"))
        .attr("stroke", "#94a3b8");

    nodesSelection.append("text")
        .attr("x", (d) => d.width / 2)
        .attr("y", (d) => d.height / 2 - (d.lines.length - 1) * 8)
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .attr("fill", (d) => (d.depth === 0 ? "#f8fafc" : "#1f2937"))
        .selectAll("tspan")
        .data((d) => d.lines.map(line => ({ line, width: d.width, lineCount: d.lines.length })))
        .enter().append("tspan")
        .attr("x", (d) => d.width / 2).attr("dy", (_, i) => (i === 0 ? 0 : 16))
        .text((d) => d.line);

    // 10. Add D3 Zoom and Pan behavior
    const zoom = d3.zoom()
        .scaleExtent([0.05, 5]) // Allow zooming out to 5% and zooming in up to 500%
        .on("zoom", (event) => {
            // Apply the matrix transform (scale/translate) to our main wrapper group
            mainGroup.attr("transform", event.transform);
        });

    // Attach the listener to the parent SVG
    svg.call(zoom);

    // --- Calculate the "Start Zoomed Out" view ---
    const paddingFit = 40; // padding inside the viewport
    const scaleX = (viewportWidth - paddingFit * 2) / svgWidth;
    const scaleY = (viewportHeight - paddingFit * 2) / svgHeightComputed;

    // Pick the smallest scale so both width and height fit on screen.
    // Cap at 1.0 so we don't accidentally zoom in massively on tiny graphs.
    const initialScale = Math.min(scaleX, scaleY, 1);

    // Center the graph horizontally and vertically
    const tx = (viewportWidth - svgWidth * initialScale) / 2;
    const ty = (viewportHeight - svgHeightComputed * initialScale) / 2;

    // Apply the initial computed state instantly
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(initialScale));

    attachInteractions(nodesSelection, edgesSelection, edges);
}
function renderError(message) {
    container.selectAll("*").remove();
    container
        .append("div")
        .style("color", "#b91c1c")
        .style("font-weight", "600")
        .text(message);
}

function buildReverseEdges(edges) {
    const reverseEdges = new Map();
    for (const [from, targets] of edges.entries()) {
        for (const target of targets) {
            if (!reverseEdges.has(target)) {
                reverseEdges.set(target, []);
            }
            reverseEdges.get(target).push(from);
        }
    }
    return reverseEdges;
}

function getImmediateNeighbors(nodeId, edges, reverseEdges) {
    const connected = new Set([nodeId]);

    const children = edges.get(nodeId) || [];
    children.forEach(child => connected.add(child));

    const parents = reverseEdges.get(nodeId) || [];
    parents.forEach(parent => connected.add(parent));

    return connected;
}

// FIX: Separating downstream vs upstream dependencies to prevent sibling leakage
function getAllConnected(startId, edges, reverseEdges) {
    const connected = new Set([startId]);

    // 1. Strict Downstream Chain: find only nodes called directly/indirectly by startId
    const queueDown = [startId];
    while (queueDown.length > 0) {
        const curr = queueDown.shift();
        const children = edges.get(curr) || [];
        for (const child of children) {
            if (!connected.has(child)) {
                connected.add(child);
                queueDown.push(child);
            }
        }
    }

    // 2. Strict Upstream Chain: find only nodes that directly/indirectly call startId
    const queueUp = [startId];
    while (queueUp.length > 0) {
        const curr = queueUp.shift();
        const parents = reverseEdges.get(curr) || [];
        for (const parent of parents) {
            if (!connected.has(parent)) {
                connected.add(parent);
                queueUp.push(parent); // Traces strictly up to parents without exploring parents' other children
            }
        }
    }

    return connected;
}

function attachInteractions(nodesSelection, edgesSelection, edgesMap) {
    const reverseEdgesMap = buildReverseEdges(edgesMap);
    let activeClickedNodeId = null;

    function updateHighlightState(activeSet) {
        if (!activeSet) {
            nodesSelection.style("opacity", 1);
            edgesSelection.style("opacity", 1);
            return;
        }

        nodesSelection.style("opacity", d => activeSet.has(d.id) ? 1 : 0.15);

        // Edge highlighting fix: an edge is only highlighted if it connects nodes
        // within the explicit linear lineage path.
        edgesSelection.style("opacity", d =>
            (activeSet.has(d.fromId) && activeSet.has(d.toId)) ? 1 : 0.05
        );
    }

    // --- Node Interactions ---
    nodesSelection
        .style("cursor", "pointer")
        .on("mouseover", function(event, d) {
            if (activeClickedNodeId) return;
            const immediateNeighbors = getImmediateNeighbors(d.id, edgesMap, reverseEdgesMap);
            updateHighlightState(immediateNeighbors);
            d3.select(this).raise();
        })
        .on("mouseout", function() {
            if (activeClickedNodeId) return;
            updateHighlightState(null);
        })
        .on("click", function(event, d) {
            if (activeClickedNodeId === d.id) {
                activeClickedNodeId = null;
                updateHighlightState(null);
            } else {
                activeClickedNodeId = d.id;
                const allConnected = getAllConnected(d.id, edgesMap, reverseEdgesMap);
                updateHighlightState(allConnected);
                d3.select(this).raise();
            }
            event.stopPropagation();
        });

    // --- Edge Interactions (UPDATED FOR BUS STACKING) ---
    edgesSelection
        .style("cursor", "crosshair")
        .attr("stroke-width", 2)
        .on("mouseover", function(event, d) {
            if (activeClickedNodeId) return;

            // 1. Initialize the active set with the shared source node
            const activeSet = new Set([d.fromId]);

            // 2. Add ALL target nodes that share this exact source node
            // This ensures every edge in the visual "stack" or "bus" gets highlighted.
            const siblings = edgesMap.get(d.fromId) || [];
            siblings.forEach(targetId => {
                activeSet.add(targetId);
            });

            updateHighlightState(activeSet);

            // 3. Raise ALL edges in this stack to the front so they aren't obscured
            edgesSelection.filter(e => e.fromId === d.fromId).raise();
        })
        .on("mouseout", function() {
            if (activeClickedNodeId) return;
            updateHighlightState(null);
        });
    // --- Background Interactions ---
    // Clear click highlights if clicking empty background space on the SVG
    d3.select("svg").on("click", () => {
        if (activeClickedNodeId) {
            activeClickedNodeId = null;
            updateHighlightState(null);
        }
    });
}