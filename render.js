// Context menu target (shared across all graph instances on this page)
let contextMenuNodeId = null;

// State management factory — each graph instance gets its own state
function createGraphState() {
    return {
        collapsedFolders: new Set(),
        collapsedFiles: new Set(),
        currentGraphData: null,
        isInitialRender: true,
        currentZoomTransform: d3.zoomIdentity,
        cachedLayout: null,
        targetElementToTrack: null,
    };
}

function renderGraph(levels, depthById, nodes, edges, containerSel, state, options) {
    const focusNodeId = (options && options.focusNodeId) || null;

    // Save state so we can re-render cleanly on toggles
    state.currentGraphData = { levels, depthById, nodes, edges };
    const container = containerSel;
    const collapsedFolders = state.collapsedFolders;
    const collapsedFiles = state.collapsedFiles;

    container.selectAll("*").remove();

    const nodeData = [];
    const basePaddingX = 16;
    const basePaddingY = 12;
    const charWidthEstimate = 6.5;
    const lineHeight = 16;
    const xSpacingBetweenNodes = 30;
    const defaultYSpacing = 160;
    const minLaneGap = 4;
    const margin = focusNodeId ? { top: 24, right: 24, bottom: 24, left: 24 } : { top: 32, right: 32, bottom: 32, left: 32 };

    const COLLAPSED_WIDTH = 16; // The "one wide" internal logic width

    // 1. Process node data
    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const labelInfo = parseNodeLabel(rawLabel);
            const lines = labelInfo.lines;

            let localMaxLineLength = 0;
            lines.forEach((line) => {
                localMaxLineLength = Math.max(localMaxLineLength, line.length);
            });

            const isDummy = String(id).startsWith("dummy|");
            const calculatedWidth = isDummy ? 0 : Math.max(32, localMaxLineLength * charWidthEstimate + basePaddingX);
            const calculatedHeight = isDummy ? 0 : Math.max(24, lines.length * lineHeight + basePaddingY);

            nodeData.push({
                id, depth, rawLabel, lines,
                width: calculatedWidth, height: calculatedHeight,
                folder: labelInfo.folder, file: labelInfo.file,
                fileKey: makeFileKey(labelInfo.folder, labelInfo.file),
                isDummy
            });
        });
    });

    const nodeDims = new Map(nodeData.map(d => [d.id, { w: d.width, h: d.height }]));

    // --- Layout Caching ---
    // Only run the randomized optimization on the very first render.
    let orderedFolders, orderedFilesByFolder, nodeOrderByFileDepth, fileMetaByKey;

    if (!state.cachedLayout || state.isInitialRender) {
        const { folderOrder: fo, fileOrderByFolder: fof, fileMetaByKey: fmbk } = buildFolderFileIndex(levels, nodes);
        const optimized = optimizeLayout(levels, depthById, nodes, edges, fo, fof);
        state.cachedLayout = {
            folderOrder: optimized.folderOrder,
            fileOrderByFolder: optimized.fileOrderByFolder,
            nodeOrderByFileDepth: optimized.nodeOrderByFileDepth,
            fileMetaByKey: fmbk
        };
    }

    orderedFolders = state.cachedLayout.folderOrder;
    orderedFilesByFolder = state.cachedLayout.fileOrderByFolder;
    nodeOrderByFileDepth = state.cachedLayout.nodeOrderByFileDepth;
    fileMetaByKey = state.cachedLayout.fileMetaByKey;

    const fileOrder = flattenFileOrder(orderedFolders, orderedFilesByFolder);
    // ---------------------------

    // 2. Compute max column widths (ignoring collapsed state initially for base metrics)
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
            if (String(id).startsWith("dummy|")) return;

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

    // 3. Calculate file X start boundaries dynamically incorporating COLLAPSED logic
    const fileStartX = new Map();
    let currentX = margin.left;

    orderedFolders.forEach((folder) => {
        const isFolderCollapsed = collapsedFolders.has(folder);
        const files = orderedFilesByFolder.get(folder) || [];

        if (isFolderCollapsed) {
            files.forEach(f => fileStartX.set(f, currentX));
            currentX += COLLAPSED_WIDTH + 40;
        } else {
            files.forEach((f) => {
                fileStartX.set(f, currentX);
                const isFileCollapsed = collapsedFiles.has(f);
                const colWidth = isFileCollapsed ? COLLAPSED_WIDTH : (fileColumnWidths.get(f) || 0);
                currentX += colWidth + 40;
            });
        }
    });

    const svgWidth = Math.max(900, currentX + margin.right);
    const positionsX = new Map();

    // 4. Pre-calculate strictly X positions first
    levels.forEach((_, depth) => {
        orderedFolders.forEach((folder) => {
            const isFolderCollapsed = collapsedFolders.has(folder);
            const files = orderedFilesByFolder.get(folder) || [];

            files.forEach((f) => {
                const isFileCollapsed = collapsedFiles.has(f);
                const depthMap = nodeOrderByFileDepth.get(f);
                const ids = depthMap ? depthMap.get(depth) : null;
                if (!ids || ids.length === 0) return;

                const realIds = ids.filter(id => !String(id).startsWith("dummy|"));
                if (realIds.length === 0) return;

                const startX = fileStartX.get(f);

                if (isFolderCollapsed || isFileCollapsed) {
                    const colCenter = startX + COLLAPSED_WIDTH / 2;
                    realIds.forEach(id => positionsX.set(id, colCenter));
                } else {
                    const totalColWidth = fileColumnWidths.get(f);
                    const colCenter = startX + totalColWidth / 2;

                    const K = realIds.length;
                    let totalSubsegmentWidth = 0;
                    realIds.forEach((id) => { totalSubsegmentWidth += nodeDims.get(id).w; });
                    totalSubsegmentWidth += (K - 1) * xSpacingBetweenNodes;

                    let segmentStartX = colCenter - totalSubsegmentWidth / 2;
                    realIds.forEach((id) => {
                        const dims = nodeDims.get(id);
                        const x = segmentStartX + dims.w / 2;
                        positionsX.set(id, x);
                        segmentStartX += dims.w + xSpacingBetweenNodes;
                    });
                }
            });
        });
    });

    // 4.5 Map dummy nodes to perfectly align with their final target node
    nodeData.forEach(d => {
        if (d.isDummy) {
            const parts = String(d.id).split("|");
            if (parts.length >= 3) {
                const targetX = positionsX.get(parts[2]);
                if (targetX !== undefined) {
                    positionsX.set(d.id, targetX);
                } else {
                    positionsX.set(d.id, 0); // safe fallback
                }
            }
        }
    });

    // 5. Generate links and perform Interval Graph Coloring
    const linkData = [];
    const layersEdges = Array.from({ length: levels.length }, () => []);

    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= levels.length) continue;
        const sourceX = positionsX.get(from);
        if (sourceX === undefined) continue;

        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) continue;
            const targetX = positionsX.get(target);
            if (targetX === undefined) continue;

            const edgeObj = {
                fromId: from, toId: target, fromDepth: fromDepth,
                leftX: Math.min(sourceX, targetX), rightX: Math.max(sourceX, targetX),
                lane: 0
            };
            linkData.push(edgeObj);
            layersEdges[fromDepth].push(edgeObj);
        }
    }

    const maxLanesPerLayer = new Array(levels.length).fill(0);

    layersEdges.forEach((layer, depth) => {
        if (layer.length === 0) return;
        const buses = new Map();
        layer.forEach((edge) => {
            if (!buses.has(edge.fromId)) {
                buses.set(edge.fromId, { fromId: edge.fromId, leftX: edge.leftX, rightX: edge.rightX, edges: [] });
            }
            const bus = buses.get(edge.fromId);
            bus.leftX = Math.min(bus.leftX, edge.leftX);
            bus.rightX = Math.max(bus.rightX, edge.rightX);
            bus.edges.push(edge);
        });

        const busArray = Array.from(buses.values());
        busArray.sort((a, b) => a.leftX - b.leftX);

        busArray.forEach((bus, index) => {
            const assignedLanes = [];
            for (let i = 0; i < index; i++) {
                const prev = busArray[i];
                if (Math.max(bus.leftX, prev.leftX) <= Math.min(bus.rightX, prev.rightX)) assignedLanes.push(prev.lane);
            }
            let lane = 0;
            while (assignedLanes.includes(lane)) lane++;
            bus.lane = lane;
            bus.edges.forEach((edge) => edge.lane = lane);
        });

        maxLanesPerLayer[depth] = Math.max(...busArray.map(b => b.lane)) + 1;
        layer.forEach(edge => edge.totalLanesInLayer = maxLanesPerLayer[depth]);
    });

    // 6. Calculate Y positions
    const depthY = new Array(levels.length).fill(0);
    let maxIndividualHeight = 24;
    nodeData.forEach(d => { if (d.height > maxIndividualHeight) maxIndividualHeight = d.height; });

    depthY[0] = margin.top + maxIndividualHeight / 2;

    for (let d = 0; d < levels.length - 1; d++) {
        const lanes = maxLanesPerLayer[d] || 1;
        const requiredLaneSpace = lanes * minLaneGap;
        const ySpacing = Math.max(defaultYSpacing, maxIndividualHeight + requiredLaneSpace + 80);
        depthY[d + 1] = depthY[d] + ySpacing;
    }

    const positions = new Map();
    nodeData.forEach((d) => {
        positions.set(d.id, { x: positionsX.get(d.id), y: depthY[d.depth] });
    });

    linkData.forEach((edge) => {
        edge.source = positions.get(edge.fromId);
        edge.target = positions.get(edge.toId);
    });

    const svgHeightComputed = depthY[levels.length - 1] + maxIndividualHeight / 2 + margin.bottom;

    // 7. Calculate precise Layout Boundaries
    const folderY = new Map();
    const fileY = new Map();

    orderedFolders.forEach(folder => folderY.set(folder, { minY: Infinity, maxY: -Infinity }));
    fileOrder.forEach(f => fileY.set(f, { minY: Infinity, maxY: -Infinity }));

    nodeData.forEach((d) => {
        const pos = positions.get(d.id);
        const fBox = folderY.get(d.folder);
        if (fBox) {
            fBox.minY = Math.min(fBox.minY, pos.y - d.height / 2);
            fBox.maxY = Math.max(fBox.maxY, pos.y + d.height / 2);
        }
        const fiBox = fileY.get(d.fileKey);
        if (fiBox) {
            fiBox.minY = Math.min(fiBox.minY, pos.y - d.height / 2);
            fiBox.maxY = Math.max(fiBox.maxY, pos.y + d.height / 2);
        }
    });

    const boxPadding = 20;
    const fileColorScale = d3.scaleOrdinal(d3.schemeCategory10);
    const folderColorScale = d3.scaleOrdinal(d3.schemeSet3);
    const folderBoxData = [];
    const fileBoxData = [];

    orderedFolders.forEach((folder, i) => {
        const files = orderedFilesByFolder.get(folder) || [];
        if (files.length === 0) return;
        const yRange = folderY.get(folder);
        if (yRange.minY === Infinity) return;

        const isCollapsed = collapsedFolders.has(folder);
        const minX = fileStartX.get(files[0]);
        const lastFile = files[files.length - 1];
        const lastFileWidth = isCollapsed ? COLLAPSED_WIDTH : (collapsedFiles.has(lastFile) ? COLLAPSED_WIDTH : fileColumnWidths.get(lastFile));
        const maxX = fileStartX.get(lastFile) + lastFileWidth;

        folderBoxData.push({
            folder,
            x: minX - boxPadding,
            y: yRange.minY - 40,
            width: maxX - minX + 2 * boxPadding,
            height: yRange.maxY - yRange.minY + 60,
            color: folderColorScale(i),
            collapsed: isCollapsed
        });
    });

    fileOrder.forEach((f, i) => {
        const meta = fileMetaByKey.get(f);
        if (!meta) return;
        const yRange = fileY.get(f);
        if (yRange.minY === Infinity) return;

        // Hide file boxes completely if parent folder is collapsed
        if (collapsedFolders.has(meta.folder)) return;

        const isCollapsed = collapsedFiles.has(f);
        const minX = fileStartX.get(f);
        const widthX = isCollapsed ? COLLAPSED_WIDTH : fileColumnWidths.get(f);
        const maxX = minX + widthX;
        const label = meta.file ? meta.file : f;

        fileBoxData.push({
            file: f, label,
            x: minX - boxPadding,
            y: yRange.minY - 20,
            width: maxX - minX + 2 * boxPadding,
            height: yRange.maxY - yRange.minY + 40,
            color: fileColorScale(i),
            collapsed: isCollapsed
        });
    });

    // --- Camera Target Compensation ---
    // Calculate how far the clicked box moved in SVG coordinates,
    // and seamlessly translate the camera to perfectly match it.
    if (state.targetElementToTrack) {
        let newX, newY;
        if (state.targetElementToTrack.type === 'folder') {
            const box = folderBoxData.find(b => b.folder === state.targetElementToTrack.id);
            if (box) { newX = box.x; newY = box.y; }
        } else if (state.targetElementToTrack.type === 'file') {
            const box = fileBoxData.find(b => b.file === state.targetElementToTrack.id);
            if (box) { newX = box.x; newY = box.y; }
        }

        if (newX !== undefined && newY !== undefined) {
            state.currentZoomTransform = state.currentZoomTransform.translate(
                state.targetElementToTrack.oldX - newX,
                state.targetElementToTrack.oldY - newY
            );
        }
        state.targetElementToTrack = null; // Clear the track target
    }

    // 8. Generate Edge Clipping Bounds Map
    const nodeContainerBounds = new Map();
    nodeData.forEach(d => nodeContainerBounds.set(d.id, { isCollapsed: false, leftX: 0, rightX: 0 }));

    folderBoxData.forEach(box => {
        if (box.collapsed) {
            nodeData.forEach(d => {
                if (d.folder === box.folder) nodeContainerBounds.set(d.id, { isCollapsed: true, leftX: box.x, rightX: box.x + box.width });
            });
        }
    });

    fileBoxData.forEach(box => {
        if (box.collapsed && !collapsedFolders.has(fileMetaByKey.get(box.file).folder)) {
            nodeData.forEach(d => {
                if (d.fileKey === box.file) nodeContainerBounds.set(d.id, { isCollapsed: true, leftX: box.x, rightX: box.x + box.width });
            });
        }
    });

    const containerNode = container.node();
    const detailPanelParent = containerNode ? containerNode.closest("#detail-panel") : null;
    const fallbackWidth = detailPanelParent
        ? (detailPanelParent.clientWidth || 540)
        : (document.getElementById("left-panel")?.clientWidth || window.innerWidth - 16);
    const viewportWidth = (containerNode && containerNode.clientWidth > 0) ? containerNode.clientWidth : fallbackWidth;
    const viewportHeight = (containerNode && containerNode.clientHeight > 0) ? containerNode.clientHeight : (document.getElementById("graph-split-container")?.clientHeight || window.innerHeight - 48);

    const svg = container.append("svg").attr("width", "100%").attr("height", "100%");
    const mainGroup = svg.append("g").attr("class", "main-zoom-group");

    // Drawing Groups Order
    const folderBoxesGroup = mainGroup.append("g").attr("class", "folder-bounding-boxes");
    const fileBoxesGroup = mainGroup.append("g").attr("class", "file-bounding-boxes");
    mainGroup.append("g").attr("class", "level-lines")
        .selectAll("line").data(levels).enter().append("line")
        .attr("x1", margin.left).attr("x2", svgWidth - margin.right)
        .attr("y1", (_, depth) => depthY[depth]).attr("y2", (_, depth) => depthY[depth])
        .attr("stroke", "#e2e8f0").attr("stroke-width", 1);
    const edgesGroup = mainGroup.append("g").attr("class", "edges");

    // Apply current toggle states if controls exist
    const showEdges = document.getElementById("toggle-edges");
    if (showEdges && !showEdges.checked) edgesGroup.style("display", "none");
    const showBoxes = document.getElementById("toggle-boxes");
    if (showBoxes && !showBoxes.checked) fileBoxesGroup.style("display", "none");
    const showFolderBoxes = document.getElementById("toggle-folder-boxes");
    if (showFolderBoxes && !showFolderBoxes.checked) folderBoxesGroup.style("display", "none");

    // --- Render Folders ---
    const folderRects = folderBoxesGroup.selectAll("g.folder-box").data(folderBoxData).enter().append("g").attr("class", "folder-box");
    folderRects.append("rect")
        .attr("x", d => d.x).attr("y", d => d.y)
        .attr("width", d => d.width).attr("height", d => d.height)
        .attr("fill", d => d.color).attr("fill-opacity", d => d.collapsed ? 0.3 : 0.05)
        .attr("stroke", d => d.color).attr("stroke-width", 2)
        .attr("stroke-dasharray", "8,4").attr("rx", 12);

    const folderToggles = folderRects.append("g")
        .style("cursor", "pointer")
        .on("click", (event, d) => {
            event.stopPropagation();
            if (collapsedFolders.has(d.folder)) collapsedFolders.delete(d.folder);
            else collapsedFolders.add(d.folder);

            // Mark this specific box's coordinates to anchor the camera against
            state.targetElementToTrack = { type: 'folder', id: d.folder, oldX: d.x, oldY: d.y };
            renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, options);
        });

    folderToggles.append("rect")
        .attr("x", d => d.x + 5).attr("y", d => d.y + 5).attr("width", 16).attr("height", 16)
        .attr("fill", "#fff").attr("stroke", d => d.color).attr("rx", 3);
    folderToggles.append("text")
        .attr("x", d => d.x + 13).attr("y", d => d.y + 17).attr("text-anchor", "middle")
        .style("font-size", "14px").style("font-weight", "bold").attr("fill", d => d.color)
        .text(d => d.collapsed ? "+" : "-");

    folderRects.append("text")
        .attr("class", "folder-box-label")
        .attr("x", d => d.x + 28).attr("y", d => d.y + 18)
        .attr("fill", d => d.color).style("font-weight", "bold").style("font-size", "14px")
        .text(d => d.collapsed ? d.folder.substring(0, 3) + ".." : d.folder)
        .append("title").text(d => d.folder);

    // --- Render Files ---
    const fileRects = fileBoxesGroup.selectAll("g.file-box").data(fileBoxData).enter().append("g").attr("class", "file-box");
    fileRects.append("rect")
        .attr("x", d => d.x).attr("y", d => d.y)
        .attr("width", d => d.width).attr("height", d => d.height)
        .attr("fill", d => d.color).attr("fill-opacity", d => d.collapsed ? 0.3 : 0.08)
        .attr("stroke", d => d.color).attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,5").attr("rx", 10);

    const fileToggles = fileRects.append("g")
        .style("cursor", "pointer")
        .on("click", (event, d) => {
            event.stopPropagation();
            if (collapsedFiles.has(d.file)) collapsedFiles.delete(d.file);
            else collapsedFiles.add(d.file);

            // Mark this specific box's coordinates to anchor the camera against
            state.targetElementToTrack = { type: 'file', id: d.file, oldX: d.x, oldY: d.y };
            renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, options);
        });

    fileToggles.append("rect")
        .attr("x", d => d.x + 5).attr("y", d => d.y + 5).attr("width", 14).attr("height", 14)
        .attr("fill", "#fff").attr("stroke", d => d.color).attr("rx", 3);
    fileToggles.append("text")
        .attr("x", d => d.x + 12).attr("y", d => d.y + 16).attr("text-anchor", "middle")
        .style("font-size", "12px").style("font-weight", "bold").attr("fill", d => d.color)
        .text(d => d.collapsed ? "+" : "-");

    fileRects.append("text")
        .attr("class", "file-box-label")
        .attr("x", d => d.x + 25).attr("y", d => d.y + 16)
        .attr("fill", d => d.color).style("font-weight", "bold").style("font-size", "12px")
        .text(d => d.collapsed ? d.label.substring(0, 3) + ".." : d.label)
        .append("title").text(d => d.label);

    // --- Render Edges ---
    const edgesSelection = edgesGroup.selectAll("path").data(linkData).enter().append("path")
        .attr("fill", "none").attr("stroke", "#94a3b8").attr("stroke-width", 1)
        .attr("d", (d) => buildPathLine(d, nodeDims, document.getElementById("toggle-orthogonal")?.checked));

    container.node().updateEdgeRouting = function() {
        const isOrthogonal = document.getElementById("toggle-orthogonal")?.checked;
        edgesSelection.attr("d", (d) => buildPathLine(d, nodeDims, isOrthogonal));
    };

    function buildPathLine(d, nodeDims, useOrthogonal) {
        const hFrom = nodeDims.get(d.fromId).h;
        const hTo = nodeDims.get(d.toId).h;

        let startX = d.source.x;
        let startY = d.source.y + (hFrom / 2);
        let endX = d.target.x;
        let endY = d.target.y - (hTo / 2);

        const srcBounds = nodeContainerBounds.get(d.fromId);
        const tgtBounds = nodeContainerBounds.get(d.toId);

        if (srcBounds.isCollapsed) {
            if (d.target.x > d.source.x) startX = srcBounds.rightX;
            else if (d.target.x < d.source.x) startX = srcBounds.leftX;
        }

        if (tgtBounds.isCollapsed) {
            if (d.source.x > d.target.x) endX = tgtBounds.rightX;
            else if (d.source.x < d.target.x) endX = tgtBounds.leftX;
        }

        if (!useOrthogonal) {
            return `M ${startX} ${startY} L ${endX} ${endY}`;
        } else {
            const verticalGap = (d.target.y - d.source.y) - (hFrom / 2) - (maxIndividualHeight / 2);
            const laneCount = d.totalLanesInLayer || 1;
            const laneOffset = ((d.lane + 1) / (laneCount + 1)) * verticalGap;
            const turnY = d.source.y + (hFrom / 2) + laneOffset;

            return `M ${startX} ${startY} L ${startX} ${turnY} L ${endX} ${turnY} L ${endX} ${endY}`;
        }
    }

    // --- Render Visible Nodes Only ---
    const visibleNodeData = nodeData.filter(d =>
        !d.isDummy && !collapsedFolders.has(d.folder) && !collapsedFiles.has(d.fileKey)
    );

    const isNodeHighlighted = (d) => {
        if (focusNodeId) return d.id === focusNodeId;
        return d.depth === 0;
    };

    const nodesSelection = mainGroup.append("g").attr("class", "nodes")
        .selectAll("g").data(visibleNodeData).enter().append("g")
        .attr("transform", (d) => {
            const position = positions.get(d.id);
            return `translate(${position.x - d.width / 2}, ${position.y - d.height / 2})`;
        });

    nodesSelection.append("rect")
        .attr("width", d => d.width).attr("height", d => d.height)
        .attr("rx", 6).attr("fill", d => (isNodeHighlighted(d) ? "#2563eb" : "#e2e8f0"))
        .attr("stroke", "#94a3b8");

    nodesSelection.append("text")
        .attr("x", d => d.width / 2).attr("y", d => d.height / 2 - (d.lines.length - 1) * 8)
        .attr("text-anchor", "middle").attr("font-size", "12px").attr("fill", d => (isNodeHighlighted(d) ? "#f8fafc" : "#1f2937"))
        .selectAll("tspan")
        .data(d => d.lines.map(line => ({ line, width: d.width, lineCount: d.lines.length })))
        .enter().append("tspan")
        .attr("x", d => d.width / 2).attr("dy", (_, i) => (i === 0 ? 0 : 16))
        .text(d => d.line);

    // --- Interaction Attachments & Zoom ---
    const zoom = d3.zoom()
        .scaleExtent([0.05, 5])
        .on("zoom", (event) => {
            state.currentZoomTransform = event.transform;
            mainGroup.attr("transform", event.transform);
        });

    svg.call(zoom);

    if (state.isInitialRender) {
        let initialScale = 1;
        let tx = 0;
        let ty = 0;

        if (focusNodeId && positions.has(focusNodeId)) {
            const focusPos = positions.get(focusNodeId);
            const paddingFit = 16;
            const scaleX = (viewportWidth - paddingFit * 2) / svgWidth;
            const scaleY = (viewportHeight - paddingFit * 2) / svgHeightComputed;

            // Maintain a comfortable, legible zoom for the focused sub-graph
            initialScale = Math.min(1, Math.max(0.65, Math.min(scaleX, scaleY)));
            if (scaleX > 0.8 && scaleY > 0.8) {
                initialScale = Math.min(scaleX, scaleY, 1);
            }

            // Always center the focused node horizontally in the exact middle of the viewport
            tx = (viewportWidth / 2) - focusPos.x * initialScale;

            // Vertically position the focused node
            const focusNode = nodeData.find(d => d.id === focusNodeId);
            const isBottomNode = focusNode && focusNode.depth === levels.length - 1 && levels.length > 1;
            const isTopNode = focusNode && focusNode.depth === 0 && levels.length > 1;

            if (svgHeightComputed * initialScale <= viewportHeight - 40) {
                ty = (viewportHeight - svgHeightComputed * initialScale) / 2;
            } else if (isBottomNode) {
                // Callers view: place focused node near bottom so callers above are visible
                ty = (viewportHeight - 70) - focusPos.y * initialScale;
            } else if (isTopNode) {
                // Callees view: place focused node near top so callees below are visible
                ty = 36 - focusPos.y * initialScale;
            } else {
                // Combined view: node is in the middle! Center focused node vertically
                ty = (viewportHeight / 2) - focusPos.y * initialScale;
            }
        } else {
            const paddingFit = 20;
            const scaleX = (viewportWidth - paddingFit * 2) / svgWidth;
            const scaleY = (viewportHeight - paddingFit * 2) / svgHeightComputed;
            initialScale = Math.min(scaleX, scaleY, 1);
            tx = (viewportWidth - svgWidth * initialScale) / 2;
            ty = (viewportHeight - svgHeightComputed * initialScale) / 2;
        }

        state.currentZoomTransform = d3.zoomIdentity.translate(tx, ty).scale(initialScale);
        state.isInitialRender = false;
    }

    // Apply the saved or actively compensated zoom seamlessly
    svg.call(zoom.transform, state.currentZoomTransform);
    mainGroup.attr("transform", state.currentZoomTransform);

    attachInteractions(nodesSelection, edgesSelection, edges, svg);
}

function renderError(message, containerSel) {
    const container = containerSel || d3.select("#visualization");
    container.selectAll("*").remove();
    container.append("div").style("color", "#b91c1c").style("font-weight", "600").text(message);
}

function buildReverseEdges(edges) {
    const reverseEdges = new Map();
    for (const [from, targets] of edges.entries()) {
        for (const target of targets) {
            if (!reverseEdges.has(target)) reverseEdges.set(target, []);
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

function getAllConnected(startId, edges, reverseEdges) {
    const connected = new Set([startId]);

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

    const queueUp = [startId];
    while (queueUp.length > 0) {
        const curr = queueUp.shift();
        const parents = reverseEdges.get(curr) || [];
        for (const parent of parents) {
            if (!connected.has(parent)) {
                connected.add(parent);
                queueUp.push(parent);
            }
        }
    }

    return connected;
}

function attachInteractions(nodesSelection, edgesSelection, edgesMap, svgEl) {
    const reverseEdgesMap = buildReverseEdges(edgesMap);
    let activeClickedNodeId = null;

    function updateHighlightState(activeSet) {
        if (!activeSet) {
            nodesSelection.style("opacity", 1);
            edgesSelection.style("opacity", 1);
            return;
        }

        nodesSelection.style("opacity", d => activeSet.has(d.id) ? 1 : 0.15);
        edgesSelection.style("opacity", d => (activeSet.has(d.fromId) && activeSet.has(d.toId)) ? 1 : 0.05);
    }

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
        })
        .on("contextmenu", function(event, d) {
            event.preventDefault();
            event.stopPropagation();

            // Skip dummy nodes
            if (d.isDummy) return;

            contextMenuNodeId = d.id;

            const ctxMenu = document.getElementById("context-menu");
            if (!ctxMenu) return;

            const functionName = d.lines[d.lines.length - 1];
            const ctxLabel = document.getElementById("ctx-open-tab");
            if (ctxLabel) ctxLabel.textContent = `🔍 Open "${functionName}" in Side Tab`;

            ctxMenu.style.display = "block";
            ctxMenu.style.left = event.clientX + "px";
            ctxMenu.style.top = event.clientY + "px";
        });

    edgesSelection
        .style("cursor", "crosshair")
        .attr("stroke-width", 2)
        .on("mouseover", function(event, d) {
            if (activeClickedNodeId) return;
            const activeSet = new Set([d.fromId]);
            const siblings = edgesMap.get(d.fromId) || [];
            siblings.forEach(targetId => activeSet.add(targetId));

            updateHighlightState(activeSet);
            edgesSelection.filter(e => e.fromId === d.fromId).raise();
        })
        .on("mouseout", function() {
            if (activeClickedNodeId) return;
            updateHighlightState(null);
        });

    svgEl.on("click", () => {
        if (activeClickedNodeId) {
            activeClickedNodeId = null;
            updateHighlightState(null);
        }
        // Hide context menu on background click
        const ctxMenu = document.getElementById("context-menu");
        if (ctxMenu) ctxMenu.style.display = "none";
    });
}