// Context menu target (shared across all graph instances on this page)
let contextMenuNodeId = null;

// State management factory — each graph instance gets its own state
function createGraphState() {
    return {
        collapsedFolders: new Set(),
        collapsedFiles: new Set(),
        currentGraphData: null,
        isInitialRender: true,
        needsFitToScreen: false,
        currentZoomTransform: d3.zoomIdentity,
        cachedLayout: null,
        targetElementToTrack: null,
        searchState: null,
        nodePositions: null,
        nodeDims: null,
        currentZoomBehavior: null,
        viewportDims: null,
        activeClickedNodeId: null,
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

    // Collapse all folders and files on initial render
    if (state.isInitialRender) {
        const shouldCollapseAll = (options && options.collapseAllOnInit !== undefined)
            ? options.collapseAllOnInit
            : !focusNodeId;
        if (shouldCollapseAll) {
            orderedFolders.forEach(folder => collapsedFolders.add(folder));
            fileOrder.forEach(file => collapsedFiles.add(file));
        }
    }

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

    // SVG Defs for search highlights
    const svgDefs = svg.append("defs");
    const filterAmber = svgDefs.append("filter")
        .attr("id", "glow-amber")
        .attr("x", "-25%").attr("y", "-25%")
        .attr("width", "150%").attr("height", "150%");
    filterAmber.append("feDropShadow")
        .attr("dx", "0").attr("dy", "1")
        .attr("stdDeviation", "4")
        .attr("flood-color", "#f59e0b")
        .attr("flood-opacity", "0.7");

    const filterActive = svgDefs.append("filter")
        .attr("id", "glow-active")
        .attr("x", "-35%").attr("y", "-35%")
        .attr("width", "170%").attr("height", "170%");
    filterActive.append("feDropShadow")
        .attr("dx", "0").attr("dy", "2")
        .attr("stdDeviation", "6")
        .attr("flood-color", "#ea580c")
        .attr("flood-opacity", "0.9");

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
        .attr("class", "graph-edge")
        .attr("fill", "none").attr("stroke", "#94a3b8").attr("stroke-width", 1)
        .attr("d", (d) => buildPathLine(d, nodeDims, document.getElementById("toggle-orthogonal")?.checked));

    container.node().updateEdgeRouting = function() {
        const isOrthogonal = document.getElementById("toggle-orthogonal")?.checked;
        edgesSelection.attr("d", (d) => buildPathLine(d, nodeDims, isOrthogonal));
    };

    container.node().expandAll = function() {
        state.collapsedFolders.clear();
        state.collapsedFiles.clear();
        state.needsFitToScreen = true;
        renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, options);
    };

    container.node().collapseAll = function() {
        state.collapsedFolders.clear();
        state.collapsedFiles.clear();
        orderedFolders.forEach(folder => state.collapsedFolders.add(folder));
        fileOrder.forEach(file => state.collapsedFiles.add(file));
        state.needsFitToScreen = true;
        renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, options);
    };

    container.node().expandFoldersOnly = function() {
        state.collapsedFolders.clear();
        state.collapsedFiles.clear();
        fileOrder.forEach(file => state.collapsedFiles.add(file));
        state.needsFitToScreen = true;
        renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, options);
    };

    container.node().search = function(query) {
        return executeSearch(query, state, container, options);
    };

    container.node().clearSearch = function() {
        state.searchState = null;
        renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, {
            ...options,
            animateToNode: false
        });
        return { count: 0, currentIndex: -1, matches: [] };
    };

    container.node().nextMatch = function() {
        if (!state.searchState || !state.searchState.matches || state.searchState.matches.length === 0) return null;
        return jumpToMatch(state.searchState.currentIndex + 1, state, container, options);
    };

    container.node().prevMatch = function() {
        if (!state.searchState || !state.searchState.matches || state.searchState.matches.length === 0) return null;
        return jumpToMatch(state.searchState.currentIndex - 1, state, container, options);
    };

    container.node().jumpToMatch = function(index) {
        return jumpToMatch(index, state, container, options);
    };

    container.node().getSearchState = function() {
        return state.searchState;
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

    const searchState = state.searchState;
    const isSearchActive = !!(searchState && searchState.query && searchState.matchingNodeIds && searchState.matchingNodeIds.size > 0);
    const activeMatchId = (isSearchActive && searchState.matches && searchState.matches.length > 0 && searchState.currentIndex >= 0)
        ? searchState.matches[searchState.currentIndex]?.id
        : null;

    const getNodeMatchType = (d) => {
        if (!isSearchActive) return null;
        return searchState.matchingTypes.get(d.id) || null;
    };

    const getNodeRectFill = (d) => {
        const mt = getNodeMatchType(d);
        if (mt) {
            if (d.id === activeMatchId) return "#ff5722"; // Active search match: radiant flaming orange-red
            if (mt === "function") return "#f59e0b"; // Function match (highest priority): vivid amber gold
            if (mt === "file") return "#8b5cf6"; // File match: vivid violet
            if (mt === "folder") return "#06b6d4"; // Folder match: electric cyan
        }
        if (isNodeHighlighted(d)) return "#2563eb";
        return "#e2e8f0";
    };

    const getNodeRectStroke = (d) => {
        const mt = getNodeMatchType(d);
        if (mt) {
            if (d.id === activeMatchId) return "#b91c1c";
            if (mt === "function") return "#b45309";
            if (mt === "file") return "#5b21b6";
            if (mt === "folder") return "#0e7490";
        }
        return "#94a3b8";
    };

    const getNodeRectStrokeWidth = (d) => {
        const mt = getNodeMatchType(d);
        if (mt) {
            if (d.id === activeMatchId) return 3.5;
            return 2.5;
        }
        return 1;
    };

    const getNodeFilter = (d) => {
        if (!isSearchActive) return null;
        if (d.id === activeMatchId) return "url(#glow-active)";
        if (getNodeMatchType(d)) return "url(#glow-amber)";
        return null;
    };

    const getNodeTextFill = (d) => {
        const mt = getNodeMatchType(d);
        if (mt) {
            if (d.id === activeMatchId) return "#ffffff";
            if (mt === "function") return "#0f172a"; // Deep bold black text on vivid amber gold
            if (mt === "file" || mt === "folder") return "#ffffff";
        }
        if (isNodeHighlighted(d)) return "#f8fafc";
        return "#1f2937";
    };

    const nodesSelection = mainGroup.append("g").attr("class", "nodes")
        .selectAll("g").data(visibleNodeData).enter().append("g")
        .attr("class", d => {
            const mt = getNodeMatchType(d);
            let cls = "node-g";
            if (mt) {
                cls += ` search-match search-match-${mt}`;
                if (d.id === activeMatchId) cls += " search-match-active";
            }
            return cls;
        })
        .attr("transform", (d) => {
            const position = positions.get(d.id);
            return `translate(${position.x - d.width / 2}, ${position.y - d.height / 2})`;
        });

    nodesSelection.append("rect")
        .attr("class", "node-rect")
        .attr("width", d => d.width).attr("height", d => d.height)
        .attr("rx", 6)
        .attr("fill", d => getNodeRectFill(d))
        .attr("stroke", d => getNodeRectStroke(d))
        .attr("stroke-width", d => getNodeRectStrokeWidth(d))
        .attr("filter", d => getNodeFilter(d));

    // Outer pulsing ring for active search match
    nodesSelection.filter(d => d.id === activeMatchId)
        .append("rect")
        .attr("class", "search-active-pulse")
        .attr("x", -4).attr("y", -4)
        .attr("width", d => d.width + 8).attr("height", d => d.height + 8)
        .attr("rx", 9)
        .attr("fill", "none")
        .attr("stroke", "#ea580c")
        .attr("stroke-width", 2.5)
        .attr("stroke-dasharray", "4,3")
        .style("pointer-events", "none");

    const textNodes = nodesSelection.append("text")
        .attr("class", "node-text")
        .attr("x", d => d.width / 2).attr("y", d => d.height / 2 - (d.lines.length - 1) * 8)
        .attr("text-anchor", "middle").attr("font-size", "12px")
        .attr("fill", d => getNodeTextFill(d));

    textNodes.selectAll("tspan")
        .data(d => d.lines.map((line, idx) => ({
            line,
            idx,
            isFuncLine: idx === d.lines.length - 1,
            matchType: getNodeMatchType(d),
            isActiveMatch: d.id === activeMatchId,
            width: d.width
        })))
        .enter().append("tspan")
        .attr("x", d => d.width / 2).attr("dy", (_, i) => (i === 0 ? 0 : 16))
        .attr("font-weight", d => {
            if (d.isActiveMatch) return "800";
            if (d.matchType === "function" && d.isFuncLine) return "800";
            if (d.matchType) return "700";
            return "normal";
        })
        .text(d => d.line);

    // --- Layout Bounding Box for Viewport Visibility Tracking ---
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    folderBoxData.forEach(b => {
        gMinX = Math.min(gMinX, b.x);
        gMinY = Math.min(gMinY, b.y);
        gMaxX = Math.max(gMaxX, b.x + b.width);
        gMaxY = Math.max(gMaxY, b.y + b.height);
    });
    fileBoxData.forEach(b => {
        gMinX = Math.min(gMinX, b.x);
        gMinY = Math.min(gMinY, b.y);
        gMaxX = Math.max(gMaxX, b.x + b.width);
        gMaxY = Math.max(gMaxY, b.y + b.height);
    });
    nodeData.forEach(d => {
        const pos = positions.get(d.id);
        if (!pos) return;
        const w = d.width || 0;
        const h = d.height || 0;
        gMinX = Math.min(gMinX, pos.x - w / 2);
        gMinY = Math.min(gMinY, pos.y - h / 2);
        gMaxX = Math.max(gMaxX, pos.x + w / 2);
        gMaxY = Math.max(gMaxY, pos.y + h / 2);
    });
    if (gMinX === Infinity) {
        gMinX = 0; gMinY = 0; gMaxX = svgWidth; gMaxY = svgHeightComputed;
    }

    function computeFitTransform(customVpWidth, customVpHeight) {
        const vpW = customVpWidth || ((containerNode && containerNode.clientWidth > 0) ? containerNode.clientWidth : fallbackWidth);
        const vpH = customVpHeight || ((containerNode && containerNode.clientHeight > 0) ? containerNode.clientHeight : (document.getElementById("graph-split-container")?.clientHeight || window.innerHeight - 48));

        let initialScale = 1;
        let tx = 0;
        let ty = 0;

        if (focusNodeId && positions.has(focusNodeId)) {
            const focusPos = positions.get(focusNodeId);
            const paddingFit = 16;
            const scaleX = (vpW - paddingFit * 2) / svgWidth;
            const scaleY = (vpH - paddingFit * 2) / svgHeightComputed;

            // Maintain a comfortable, legible zoom for the focused sub-graph
            initialScale = Math.min(1, Math.max(0.65, Math.min(scaleX, scaleY)));
            if (scaleX > 0.8 && scaleY > 0.8) {
                initialScale = Math.min(scaleX, scaleY, 1);
            }

            // Always center the focused node horizontally in the exact middle of the viewport
            tx = (vpW / 2) - focusPos.x * initialScale;

            // Vertically position the focused node
            const focusNode = nodeData.find(d => d.id === focusNodeId);
            const isBottomNode = focusNode && focusNode.depth === levels.length - 1 && levels.length > 1;
            const isTopNode = focusNode && focusNode.depth === 0 && levels.length > 1;

            if (svgHeightComputed * initialScale <= vpH - 40) {
                ty = (vpH - svgHeightComputed * initialScale) / 2;
            } else if (isBottomNode) {
                // Callers view: place focused node near bottom so callers above are visible
                ty = (vpH - 70) - focusPos.y * initialScale;
            } else if (isTopNode) {
                // Callees view: place focused node near top so callees below are visible
                ty = 36 - focusPos.y * initialScale;
            } else {
                // Combined view: node is in the middle! Center focused node vertically
                ty = (vpH / 2) - focusPos.y * initialScale;
            }
        } else {
            const paddingFit = 20;
            const scaleX = (vpW - paddingFit * 2) / svgWidth;
            const scaleY = (vpH - paddingFit * 2) / svgHeightComputed;
            initialScale = Math.min(scaleX, scaleY, 1);
            tx = (vpW - svgWidth * initialScale) / 2;
            ty = (vpH - svgHeightComputed * initialScale) / 2;
        }

        return d3.zoomIdentity.translate(tx, ty).scale(initialScale);
    }

    // --- Floating "Back to Graph" Navigation Button ---
    const backBtn = container.append("button")
        .attr("type", "button")
        .attr("class", "btn-back-to-graph")
        .attr("title", "Navigate back to view the graph")
        .attr("aria-label", "Navigate back to view the graph");

    const backBtnArrow = backBtn.append("span")
        .attr("class", "back-graph-arrow")
        .text("⌖");

    backBtn.append("span")
        .attr("class", "back-graph-text")
        .text("Back to Graph");

    function updateNavButton() {
        const vpW = (containerNode && containerNode.clientWidth > 0) ? containerNode.clientWidth : fallbackWidth;
        const vpH = (containerNode && containerNode.clientHeight > 0) ? containerNode.clientHeight : (document.getElementById("graph-split-container")?.clientHeight || window.innerHeight - 48);
        const transform = state.currentZoomTransform || d3.zoomIdentity;

        const screenLeft = transform.x + gMinX * transform.k;
        const screenTop = transform.y + gMinY * transform.k;
        const screenRight = transform.x + gMaxX * transform.k;
        const screenBottom = transform.y + gMaxY * transform.k;

        // Check if any part of the graph bounding box is visible in the viewport
        const isVisible = !(
            screenRight <= 10 ||
            screenLeft >= vpW - 10 ||
            screenBottom <= 10 ||
            screenTop >= vpH - 10
        );

        if (isVisible) {
            backBtn.classed("visible", false);
        } else {
            // Calculate direction from center of viewport to center of graph
            const graphCenterX = transform.x + ((gMinX + gMaxX) / 2) * transform.k;
            const graphCenterY = transform.y + ((gMinY + gMaxY) / 2) * transform.k;
            const vpCenterX = vpW / 2;
            const vpCenterY = vpH / 2;
            const dx = graphCenterX - vpCenterX;
            const dy = graphCenterY - vpCenterY;
            const angle = Math.atan2(dy, dx) * (180 / Math.PI);

            let arrow = "⌖";
            if (angle >= -22.5 && angle < 22.5) {
                arrow = "→";
            } else if (angle >= 22.5 && angle < 67.5) {
                arrow = "↘";
            } else if (angle >= 67.5 && angle < 112.5) {
                arrow = "↓";
            } else if (angle >= 112.5 && angle < 157.5) {
                arrow = "↙";
            } else if (angle >= 157.5 || angle < -157.5) {
                arrow = "←";
            } else if (angle >= -157.5 && angle < -112.5) {
                arrow = "↖";
            } else if (angle >= -112.5 && angle < -67.5) {
                arrow = "↑";
            } else if (angle >= -67.5 && angle < -22.5) {
                arrow = "↗";
            }

            backBtnArrow.text(arrow);
            backBtn.classed("visible", true);
        }
    }

    backBtn.on("click", (event) => {
        event.stopPropagation();
        event.preventDefault();
        const targetTransform = computeFitTransform();
        state.currentZoomTransform = targetTransform;
        svg.transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .call(zoom.transform, targetTransform)
            .on("end", () => {
                updateNavButton();
            });
    });

    if (window.ResizeObserver && containerNode) {
        if (containerNode._navResizeObserver) {
            containerNode._navResizeObserver.disconnect();
        }
        const ro = new ResizeObserver(() => {
            updateNavButton();
        });
        ro.observe(containerNode);
        containerNode._navResizeObserver = ro;
    }

    container.node().navigateBackToGraph = function() {
        const targetTransform = computeFitTransform();
        state.currentZoomTransform = targetTransform;
        svg.transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .call(zoom.transform, targetTransform)
            .on("end", () => {
                updateNavButton();
            });
    };

    // --- Interaction Attachments & Zoom ---
    const zoom = d3.zoom()
        .scaleExtent([0.05, 5])
        .on("zoom", (event) => {
            state.currentZoomTransform = event.transform;
            mainGroup.attr("transform", event.transform);
            updateNavButton();
        });

    svg.call(zoom);

    if (state.isInitialRender || state.needsFitToScreen) {
        state.currentZoomTransform = computeFitTransform(viewportWidth, viewportHeight);
        state.isInitialRender = false;
        state.needsFitToScreen = false;
    }

    state.currentZoomBehavior = zoom;
    state.nodePositions = positions;
    state.nodeDims = nodeDims;
    state.viewportDims = { width: viewportWidth, height: viewportHeight };

    // Apply the saved or actively compensated zoom seamlessly
    svg.call(zoom.transform, state.currentZoomTransform);
    mainGroup.attr("transform", state.currentZoomTransform);
    updateNavButton();

    // If focusing on a search node, smoothly pan to it
    if (options && options.focusSearchNodeId && positions.has(options.focusSearchNodeId)) {
        const targetPos = positions.get(options.focusSearchNodeId);
        const currentScale = state.currentZoomTransform.k;
        const targetScale = Math.max(currentScale, 0.75);

        const targetTx = (viewportWidth / 2) - targetPos.x * targetScale;
        const targetTy = (viewportHeight / 2) - targetPos.y * targetScale;
        const targetTransform = d3.zoomIdentity.translate(targetTx, targetTy).scale(targetScale);

        state.currentZoomTransform = targetTransform;
        if (options.animateToNode !== false) {
            svg.transition()
                .duration(500)
                .ease(d3.easeCubicOut)
                .call(zoom.transform, targetTransform);
        } else {
            svg.call(zoom.transform, targetTransform);
        }
    }

    attachInteractions(nodesSelection, edgesSelection, edges, svg, state, {
        getNodeRectFill,
        getNodeRectStroke,
        getNodeRectStrokeWidth,
        getNodeFilter,
        getNodeTextFill
    });
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

function attachInteractions(nodesSelection, edgesSelection, edgesMap, svgEl, state, styleHelpers) {
    const reverseEdgesMap = buildReverseEdges(edgesMap);
    let activeClickedNodeId = (state && state.activeClickedNodeId) || null;

    const {
        getNodeRectFill = (d) => (d.depth === 0 ? "#2563eb" : "#e2e8f0"),
        getNodeRectStroke = () => "#94a3b8",
        getNodeRectStrokeWidth = () => 1,
        getNodeFilter = () => null,
        getNodeTextFill = (d) => (d.depth === 0 ? "#f8fafc" : "#1f2937")
    } = (styleHelpers || {});

    const isSearchActive = () => !!(state && state.searchState && state.searchState.matchingNodeIds && state.searchState.matchingNodeIds.size > 0);

    function updateHighlightState(activeSet, primaryId) {
        if (!activeSet) {
            nodesSelection.each(function(d) {
                const g = d3.select(this);
                g.classed("node-primary-highlight", false);
                g.classed("node-connected-highlight", false);

                if (isSearchActive()) {
                    g.style("opacity", state.searchState.matchingNodeIds.has(d.id) ? 1 : 0.35);
                } else {
                    g.style("opacity", 1);
                }
                g.select("rect.node-rect")
                    .attr("fill", getNodeRectFill(d))
                    .attr("stroke", getNodeRectStroke(d))
                    .attr("stroke-width", getNodeRectStrokeWidth(d))
                    .style("filter", getNodeFilter(d) || "none");
                g.select("text.node-text")
                    .attr("fill", getNodeTextFill(d));
                g.selectAll("tspan")
                    .attr("font-weight", (t) => {
                        if (t && t.isActiveMatch) return "800";
                        if (t && t.matchType === "function" && t.isFuncLine) return "800";
                        if (t && t.matchType) return "700";
                        return "normal";
                    });
            });

            if (isSearchActive()) {
                edgesSelection.style("opacity", 0.15)
                    .attr("stroke", "#94a3b8")
                    .attr("stroke-width", 1);
            } else {
                edgesSelection.style("opacity", 1)
                    .attr("stroke", "#94a3b8")
                    .attr("stroke-width", 1);
            }
            return;
        }

        nodesSelection.each(function(d) {
            const g = d3.select(this);
            const isPrimary = !!(primaryId && d.id === primaryId);
            const isConnected = activeSet.has(d.id);

            g.classed("node-primary-highlight", isPrimary);
            g.classed("node-connected-highlight", isConnected && !isPrimary);

            if (isPrimary) {
                // Primary node (Hovered or Clicked): MUCH stronger contrast
                g.style("opacity", 1);
                g.select("rect.node-rect")
                    .attr("fill", "#0f172a") // Deep slate-900 / dark contrast
                    .attr("stroke", "#38bdf8") // Vivid luminous sky-blue border
                    .attr("stroke-width", 3)
                    .style("filter", "drop-shadow(0 4px 8px rgba(15, 23, 42, 0.45))");
                g.select("text.node-text")
                    .attr("fill", "#ffffff"); // Pure white
                g.selectAll("tspan")
                    .attr("font-weight", (t) => (t && t.isFuncLine ? "800" : "700"));
            } else if (isConnected) {
                // Connected nodes: SOMEWHAT stronger contrast
                g.style("opacity", 1);
                g.select("rect.node-rect")
                    .attr("fill", "#2563eb") // Rich Royal Blue 600
                    .attr("stroke", "#1d4ed8") // Deep blue 700 border
                    .attr("stroke-width", 2)
                    .style("filter", "none");
                g.select("text.node-text")
                    .attr("fill", "#ffffff"); // Pure white
                g.selectAll("tspan")
                    .attr("font-weight", (t) => (t && t.isFuncLine ? "700" : "600"));
            } else {
                // Non-highlighted nodes: keep opacity as before
                if (isSearchActive()) {
                    g.style("opacity", state.searchState.matchingNodeIds.has(d.id) ? 1 : 0.35);
                } else {
                    g.style("opacity", 1);
                }
                g.select("rect.node-rect")
                    .attr("fill", getNodeRectFill(d))
                    .attr("stroke", getNodeRectStroke(d))
                    .attr("stroke-width", getNodeRectStrokeWidth(d))
                    .style("filter", "none");
                g.select("text.node-text")
                    .attr("fill", getNodeTextFill(d));
                g.selectAll("tspan")
                    .attr("font-weight", (t) => {
                        if (t && t.isActiveMatch) return "800";
                        if (t && t.matchType === "function" && t.isFuncLine) return "800";
                        if (t && t.matchType) return "700";
                        return "normal";
                    });
            }
        });

        // Edges styling: direct links to primary node are boldest, other active edges distinct; opacity preserved
        const defaultEdgeOpacity = isSearchActive() ? 0.15 : 1;
        edgesSelection.each(function(d) {
            const edge = d3.select(this);
            const isConnectedToPrimary = primaryId && (d.fromId === primaryId || d.toId === primaryId);
            const isConnectedInActiveSet = activeSet.has(d.fromId) && activeSet.has(d.toId);

            edge.style("opacity", defaultEdgeOpacity);

            if (isConnectedToPrimary) {
                edge.attr("stroke", "#2563eb")
                    .attr("stroke-width", 2.5);
            } else if (isConnectedInActiveSet) {
                edge.attr("stroke", "#3b82f6")
                    .attr("stroke-width", 2);
            } else {
                edge.attr("stroke", "#94a3b8")
                    .attr("stroke-width", 1);
            }
        });

        // Layering order: active edges -> connected nodes -> primary node on top
        edgesSelection.filter(d => activeSet.has(d.fromId) && activeSet.has(d.toId)).raise();
        nodesSelection.filter(d => activeSet.has(d.id) && d.id !== primaryId).raise();
        if (primaryId) {
            nodesSelection.filter(d => d.id === primaryId).raise();
        }
    }

    // Restore active clicked node or search state
    if (activeClickedNodeId && nodesSelection.data().some(d => d.id === activeClickedNodeId)) {
        const allConnected = getAllConnected(activeClickedNodeId, edgesMap, reverseEdgesMap);
        updateHighlightState(allConnected, activeClickedNodeId);
    } else {
        activeClickedNodeId = null;
        if (state) state.activeClickedNodeId = null;
        updateHighlightState(null, null);
    }

    nodesSelection
        .style("cursor", "pointer")
        .on("mouseover", function(event, d) {
            if (activeClickedNodeId) return;
            const immediateNeighbors = getImmediateNeighbors(d.id, edgesMap, reverseEdgesMap);
            updateHighlightState(immediateNeighbors, d.id);
        })
        .on("mouseout", function() {
            if (activeClickedNodeId) return;
            updateHighlightState(null, null);
        })
        .on("click", function(event, d) {
            if (activeClickedNodeId === d.id) {
                activeClickedNodeId = null;
                if (state) state.activeClickedNodeId = null;
                updateHighlightState(null, null);
            } else {
                activeClickedNodeId = d.id;
                if (state) state.activeClickedNodeId = d.id;
                const allConnected = getAllConnected(d.id, edgesMap, reverseEdgesMap);
                updateHighlightState(allConnected, d.id);
            }
            event.stopPropagation();
        })
        .on("contextmenu", function(event, d) {
            event.preventDefault();
            event.stopPropagation();

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
        .attr("stroke-width", 1)
        .on("mouseover", function(event, d) {
            if (activeClickedNodeId) return;
            const activeSet = new Set([d.fromId]);
            const siblings = edgesMap.get(d.fromId) || [];
            siblings.forEach(targetId => activeSet.add(targetId));

            updateHighlightState(activeSet, d.fromId);
        })
        .on("mouseout", function() {
            if (activeClickedNodeId) return;
            updateHighlightState(null, null);
        });

    svgEl.on("click", (event) => {
        if (event && event.defaultPrevented) return;
        if (activeClickedNodeId) {
            activeClickedNodeId = null;
            if (state) state.activeClickedNodeId = null;
            updateHighlightState(null, null);
        }
        // Hide context menu on background click
        const ctxMenu = document.getElementById("context-menu");
        if (ctxMenu) ctxMenu.style.display = "none";
    });
}

// --- Search Engine Implementation ---

function executeSearch(query, state, container, options) {
    const q = (query || "").trim().toLowerCase();
    if (!q) {
        state.searchState = null;
        renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, {
            ...options,
            animateToNode: false
        });
        return { count: 0, currentIndex: -1, matches: [] };
    }

    if (!state.currentGraphData) {
        return { count: 0, currentIndex: -1, matches: [] };
    }

    const { depthById, nodes, levels, edges } = state.currentGraphData;
    const matches = [];

    // Search reachable nodes in the current graph
    for (const [id, depth] of depthById.entries()) {
        if (String(id).startsWith("dummy|")) continue;

        const rawLabel = nodes.get(id) || id;
        const labelInfo = parseNodeLabel(rawLabel);
        const func = (labelInfo.lines[labelInfo.lines.length - 1] || "").trim();
        const file = (labelInfo.file || "").trim();
        const folder = (labelInfo.folder || "").trim();
        const fileKey = makeFileKey(folder, file);

        const funcLower = func.toLowerCase();
        const fileLower = file.toLowerCase();
        const folderLower = folder.toLowerCase();

        let matchType = null;
        let rank = 100;

        // "function names are the most important" -> prioritized top ranks
        if (funcLower === q) {
            matchType = "function";
            rank = 1; // exact match
        } else if (funcLower.startsWith(q)) {
            matchType = "function";
            rank = 2; // prefix match
        } else if (funcLower.includes(q)) {
            matchType = "function";
            rank = 3; // substring match
        } else if (fileLower === q) {
            matchType = "file";
            rank = 10;
        } else if (fileLower.includes(q)) {
            matchType = "file";
            rank = 11;
        } else if (folderLower === q) {
            matchType = "folder";
            rank = 20;
        } else if (folderLower.includes(q)) {
            matchType = "folder";
            rank = 21;
        }

        if (matchType) {
            matches.push({
                id,
                type: matchType,
                rank,
                func,
                file,
                folder,
                fileKey,
                depth
            });
        }
    }

    // Sort matches: functions first (by rank), then alphabetically by func, then depth
    matches.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        const cmp = a.func.localeCompare(b.func);
        if (cmp !== 0) return cmp;
        return a.depth - b.depth;
    });

    if (matches.length === 0) {
        state.searchState = {
            query: q,
            matches: [],
            currentIndex: -1,
            matchingNodeIds: new Set(),
            matchingTypes: new Map()
        };
        renderGraph(levels, depthById, nodes, edges, container, state, {
            ...options,
            animateToNode: false
        });
        return { count: 0, currentIndex: -1, matches: [] };
    }

    // "if the folder or file is closed, open it, so it is visible for sure"
    matches.forEach(m => {
        if (m.folder) {
            state.collapsedFolders.delete(m.folder);
        }
        if (m.fileKey) {
            state.collapsedFiles.delete(m.fileKey);
        }
    });

    const currentIndex = 0;
    state.searchState = {
        query: q,
        matches,
        currentIndex,
        matchingNodeIds: new Set(matches.map(m => m.id)),
        matchingTypes: new Map(matches.map(m => [m.id, m.type]))
    };

    renderGraph(levels, depthById, nodes, edges, container, state, {
        ...options,
        collapseAllOnInit: false,
        focusSearchNodeId: matches[0].id,
        animateToNode: true
    });

    return {
        count: matches.length,
        currentIndex: 0,
        matches
    };
}

function jumpToMatch(index, state, container, options) {
    if (!state.searchState || !state.searchState.matches || state.searchState.matches.length === 0) {
        return null;
    }
    const matches = state.searchState.matches;
    const clampedIndex = (index % matches.length + matches.length) % matches.length;
    state.searchState.currentIndex = clampedIndex;
    const target = matches[clampedIndex];

    // Ensure folder and file are open
    let needsReRender = false;
    if (target.folder && state.collapsedFolders.has(target.folder)) {
        state.collapsedFolders.delete(target.folder);
        needsReRender = true;
    }
    if (target.fileKey && state.collapsedFiles.has(target.fileKey)) {
        state.collapsedFiles.delete(target.fileKey);
        needsReRender = true;
    }

    if (needsReRender) {
        renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, {
            ...options,
            collapseAllOnInit: false,
            focusSearchNodeId: target.id,
            animateToNode: true
        });
    } else {
        updateActiveSearchMatchInDOM(container, state, target.id);
    }

    return {
        count: matches.length,
        currentIndex: clampedIndex,
        matches
    };
}

function updateActiveSearchMatchInDOM(container, state, targetId) {
    const searchState = state.searchState;
    if (!searchState) return;

    const nodesGroup = container.select("g.nodes");
    if (nodesGroup.empty()) return;

    // Remove old active pulse rings
    nodesGroup.selectAll(".search-active-pulse").remove();

    // Update node groups in-place
    nodesGroup.selectAll("g.node-g").each(function(d) {
        const isTarget = d.id === targetId;
        const mt = searchState.matchingTypes.get(d.id);
        const g = d3.select(this);

        if (mt) {
            g.classed("search-match-active", isTarget);
            const rect = g.select("rect.node-rect");
            const text = g.select("text");

            if (isTarget) {
                rect.attr("fill", "#ff5722")
                    .attr("stroke", "#b91c1c")
                    .attr("stroke-width", 3.5)
                    .attr("filter", "url(#glow-active)");
                text.attr("fill", "#ffffff");

                // Add active pulsing ring
                g.append("rect")
                    .attr("class", "search-active-pulse")
                    .attr("x", -4).attr("y", -4)
                    .attr("width", d.width + 8).attr("height", d.height + 8)
                    .attr("rx", 9)
                    .attr("fill", "none")
                    .attr("stroke", "#ea580c")
                    .attr("stroke-width", 2.5)
                    .attr("stroke-dasharray", "4,3")
                    .style("pointer-events", "none");
            } else {
                rect.attr("fill", mt === "function" ? "#f59e0b" : (mt === "file" ? "#8b5cf6" : "#06b6d4"))
                    .attr("stroke", mt === "function" ? "#b45309" : (mt === "file" ? "#5b21b6" : "#0e7490"))
                    .attr("stroke-width", 2.5)
                    .attr("filter", "url(#glow-amber)");
                text.attr("fill", mt === "function" ? "#0f172a" : "#ffffff");
            }
        }
    });

    // Pan camera smoothly
    const pos = state.nodePositions?.get(targetId);
    if (pos && state.currentZoomBehavior) {
        const currentScale = state.currentZoomTransform.k;
        const targetScale = Math.max(currentScale, 0.75);
        const vp = state.viewportDims || { width: 800, height: 600 };
        const targetTx = (vp.width / 2) - pos.x * targetScale;
        const targetTy = (vp.height / 2) - pos.y * targetScale;
        const targetTransform = d3.zoomIdentity.translate(targetTx, targetTy).scale(targetScale);

        state.currentZoomTransform = targetTransform;
        container.select("svg").transition()
            .duration(450)
            .ease(d3.easeCubicOut)
            .call(state.currentZoomBehavior.transform, targetTransform);
    }
}