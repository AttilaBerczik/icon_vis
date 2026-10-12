// Context menu target (shared across all graph instances on this page)
let contextMenuNodeId = null;

// Global persistent color maps ensuring 100% consistent folder and file box colors
// across main view, side panel tabs, and sub-graphs.
const globalFolderColorMap = new Map();
const globalFileColorMap = new Map();

function getFolderColor(folder) {
    if (!folder) return "#94a3b8";
    if (!globalFolderColorMap.has(folder)) {
        const color = d3.schemeSet3[globalFolderColorMap.size % d3.schemeSet3.length];
        globalFolderColorMap.set(folder, color);
    }
    return globalFolderColorMap.get(folder);
}

function getFileColor(fileKey) {
    if (!fileKey) return "#64748b";
    if (!globalFileColorMap.has(fileKey)) {
        const color = d3.schemeCategory10[globalFileColorMap.size % d3.schemeCategory10.length];
        globalFileColorMap.set(fileKey, color);
    }
    return globalFileColorMap.get(fileKey);
}

window.globalFolderColorMap = globalFolderColorMap;
window.globalFileColorMap = globalFileColorMap;
window.getFolderColor = getFolderColor;
window.getFileColor = getFileColor;

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

// --- Spatial Index for Viewport Culling (Phase 1) ---
class SpatialIndex {
    constructor(cellSize = 600) {
        this.cellSize = cellSize;
        this.cells = new Map();
    }

    clear() {
        this.cells.clear();
    }

    insert(item, minX, minY, maxX, maxY) {
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return;
        const startC = Math.floor(minX / this.cellSize);
        const endC = Math.floor(maxX / this.cellSize);
        const startR = Math.floor(minY / this.cellSize);
        const endR = Math.floor(maxY / this.cellSize);

        for (let c = startC; c <= endC; c++) {
            for (let r = startR; r <= endR; r++) {
                const k = `${c},${r}`;
                let list = this.cells.get(k);
                if (!list) {
                    list = [];
                    this.cells.set(k, list);
                }
                list.push(item);
            }
        }
    }

    // Insert an item that may span a large area. Small items are inserted into
    // every covered cell. Large items (long edges) are sampled along their
    // bounding-box diagonal instead, which keeps the index size proportional to
    // the span length rather than the spanned area. This prevents the index from
    // exploding on very wide graphs (a single edge could otherwise occupy
    // thousands of cells and hundreds of thousands of references).
    insertSampled(item, minX, minY, maxX, maxY, maxCells = 256) {
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return;
        const startC = Math.floor(minX / this.cellSize);
        const endC = Math.floor(maxX / this.cellSize);
        const startR = Math.floor(minY / this.cellSize);
        const endR = Math.floor(maxY / this.cellSize);
        const cellCount = (endC - startC + 1) * (endR - startR + 1);

        if (cellCount <= maxCells) {
            this.insert(item, minX, minY, maxX, maxY);
            return;
        }

        const dx = maxX - minX;
        const dy = maxY - minY;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / this.cellSize));
        const seen = new Set();
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = minX + dx * t;
            const y = minY + dy * t;
            const k = `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
            if (seen.has(k)) continue;
            seen.add(k);
            let list = this.cells.get(k);
            if (!list) {
                list = [];
                this.cells.set(k, list);
            }
            list.push(item);
        }
    }

    query(minX, minY, maxX, maxY) {
        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) return [];
        const startC = Math.floor(minX / this.cellSize);
        const endC = Math.floor(maxX / this.cellSize);
        const startR = Math.floor(minY / this.cellSize);
        const endR = Math.floor(maxY / this.cellSize);

        const seen = new Set();
        const results = [];
        for (let c = startC; c <= endC; c++) {
            for (let r = startR; r <= endR; r++) {
                const list = this.cells.get(`${c},${r}`);
                if (list) {
                    for (let i = 0; i < list.length; i++) {
                        const item = list[i];
                        if (!seen.has(item)) {
                            seen.add(item);
                            results.push(item);
                        }
                    }
                }
            }
        }
        return results;
    }
}

function renderGraph(levels, depthById, nodes, edges, containerSel, state, options) {
    const focusNodeId = (options && options.focusNodeId) || null;
    if (focusNodeId) {
        state.focusNodeId = focusNodeId;
    } else if (options && options.activeTabNodeId !== undefined) {
        state.activeTabNodeId = options.activeTabNodeId;
    } else if (state.activeTabNodeId === undefined && window.detailPanelManager && typeof window.detailPanelManager.getActiveNodeId === "function") {
        state.activeTabNodeId = window.detailPanelManager.getActiveNodeId();
    }

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
                folder: isDummy ? null : labelInfo.folder,
                file: isDummy ? null : labelInfo.file,
                fileKey: isDummy ? null : makeFileKey(labelInfo.folder, labelInfo.file),
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

    // Pre-register colors for all folders and files in this layout order
    // to guarantee consistent indexing across views (even if folders/files are collapsed)
    orderedFolders.forEach(folder => getFolderColor(folder));
    fileOrder.forEach(file => getFileColor(file));

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

    // 2.5. Hierarchical Interval Graph Coloring: pack folders and files into shared column slots
    // Compute per-file and per-folder layer sets
    const fileLayers = new Map();
    fileOrder.forEach(f => fileLayers.set(f, new Set()));

    levels.forEach((levelIds, depth) => {
        levelIds.forEach(id => {
            if (String(id).startsWith("dummy|")) return;
            const fileKey = getNodeFileKey(id, nodes);
            if (fileLayers.has(fileKey)) {
                fileLayers.get(fileKey).add(depth);
            }
        });
    });

    const folderLayers = new Map();
    orderedFolders.forEach(folder => folderLayers.set(folder, new Set()));

    levels.forEach((levelIds, depth) => {
        levelIds.forEach(id => {
            if (String(id).startsWith("dummy|")) return;
            const folder = getNodeFolder(id, nodes);
            if (folderLayers.has(folder)) {
                folderLayers.get(folder).add(depth);
            }
        });
    });

    const hasRealFolders = orderedFolders.some(f => f && f.length > 0);

    let globalSlots = []; // array of { layers: Set, files: [] }
    const fileToSlot = new Map(); // fileKey -> globalSlotIndex
    const folderStartSlot = new Map(); // folder -> startSlotIndex

    if (!hasRealFolders) {
        // Flat file mode (e.g. callgraph.dot): pack files directly across column slots
        fileOrder.forEach(f => {
            const layers = fileLayers.get(f) || new Set();
            let assigned = -1;
            for (let s = 0; s < globalSlots.length; s++) {
                let overlap = false;
                for (const d of layers) {
                    if (globalSlots[s].layers.has(d)) {
                        overlap = true;
                        break;
                    }
                }
                if (!overlap) {
                    assigned = s;
                    break;
                }
            }
            if (assigned === -1) {
                assigned = globalSlots.length;
                globalSlots.push({ files: [], layers: new Set() });
            }
            globalSlots[assigned].files.push(f);
            for (const d of layers) globalSlots[assigned].layers.add(d);
            fileToSlot.set(f, assigned);
        });
    } else {
        // Hierarchical mode: pack files inside each folder, and pack folders across columns
        const folderInternalSlots = new Map(); // folder -> array of { files: [], layers: Set }

        orderedFolders.forEach(folder => {
            const files = orderedFilesByFolder.get(folder) || [];
            if (files.length === 0) return;

            const isFolderCollapsed = collapsedFolders.has(folder);
            if (isFolderCollapsed) {
                const layers = folderLayers.get(folder) || new Set();
                folderInternalSlots.set(folder, [{ files: files.slice(), layers }]);
                return;
            }

            const internalSlots = [];
            files.forEach(f => {
                const layers = fileLayers.get(f) || new Set();
                let assigned = -1;
                for (let s = 0; s < internalSlots.length; s++) {
                    let overlap = false;
                    for (const d of layers) {
                        if (internalSlots[s].layers.has(d)) {
                            overlap = true;
                            break;
                        }
                    }
                    if (!overlap) {
                        assigned = s;
                        break;
                    }
                }
                if (assigned === -1) {
                    assigned = internalSlots.length;
                    internalSlots.push({ files: [], layers: new Set() });
                }
                internalSlots[assigned].files.push(f);
                for (const d of layers) internalSlots[assigned].layers.add(d);
            });
            folderInternalSlots.set(folder, internalSlots);
        });

        orderedFolders.forEach(folder => {
            const intSlots = folderInternalSlots.get(folder) || [];
            if (intSlots.length === 0) return;
            const K = intSlots.length;
            const flayers = folderLayers.get(folder) || new Set();

            // Find first starting slot where folder fits across all K consecutive columns
            let startSlot = 0;
            while (true) {
                let fits = true;
                for (let k = 0; k < K; k++) {
                    const sIdx = startSlot + k;
                    if (sIdx < globalSlots.length) {
                        for (const d of flayers) {
                            if (globalSlots[sIdx].layers.has(d)) {
                                fits = false;
                                break;
                            }
                        }
                    }
                    if (!fits) break;
                }
                if (fits) break;
                startSlot++;
            }

            while (globalSlots.length < startSlot + K) {
                globalSlots.push({ layers: new Set(), files: [] });
            }

            folderStartSlot.set(folder, startSlot);

            for (let k = 0; k < K; k++) {
                const gSlot = startSlot + k;
                const intSlot = intSlots[k];
                intSlot.files.forEach(f => {
                    globalSlots[gSlot].files.push(f);
                    fileToSlot.set(f, gSlot);
                });
                for (const d of flayers) {
                    globalSlots[gSlot].layers.add(d);
                }
            }
        });
    }

    if (globalSlots.length === 0) {
        globalSlots.push({ files: [], layers: new Set() });
    }

    // Compute width of each global column slot
    const slotWidths = globalSlots.map((slot) => {
        let maxW = 0;
        for (const f of slot.files) {
            const folder = fileMetaByKey.get(f)?.folder;
            const isFolderCollapsed = folder && collapsedFolders.has(folder);
            const isFileCollapsed = collapsedFiles.has(f);
            const w = (isFolderCollapsed || isFileCollapsed) ? COLLAPSED_WIDTH : (fileColumnWidths.get(f) || 0);
            maxW = Math.max(maxW, w);
        }
        return maxW || COLLAPSED_WIDTH;
    });

    // 3. Calculate file X start boundaries using column slots
    const fileStartX = new Map();
    const slotStartX = [];
    let currentX = margin.left;

    for (let s = 0; s < globalSlots.length; s++) {
        slotStartX.push(currentX);
        for (const f of globalSlots[s].files) {
            fileStartX.set(f, currentX);
        }
        currentX += slotWidths[s] + 40;
    }

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
                const slotIdx = fileToSlot.get(f);
                const slotW = (slotIdx !== undefined) ? slotWidths[slotIdx] : (fileColumnWidths.get(f) || 0);

                if (isFolderCollapsed || isFileCollapsed) {
                    const colCenter = startX + COLLAPSED_WIDTH / 2;
                    realIds.forEach(id => positionsX.set(id, colCenter));
                } else {
                    const totalColWidth = fileColumnWidths.get(f);
                    // Center this file's content within the (potentially wider) slot
                    const colCenter = startX + slotW / 2;

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
            let realTgt = d.id;
            const visited = new Set();
            while (String(realTgt).startsWith("dummy|") && !visited.has(realTgt)) {
                visited.add(realTgt);
                const next = edges.get(realTgt);
                if (next && next.length > 0) realTgt = next[0];
                else break;
            }
            if (String(realTgt).startsWith("dummy|")) {
                const parts = String(d.id).split("|");
                if (parts.length >= 3) realTgt = parts[2];
            }
            const targetX = positionsX.get(realTgt);
            if (targetX !== undefined) {
                positionsX.set(d.id, targetX);
            } else {
                positionsX.set(d.id, 0); // safe fallback
            }
        }
    });

    // 5. Generate links and perform Interval Graph Coloring
    const linkData = [];
    const layersEdges = Array.from({ length: levels.length }, () => []);
    const reverseEdgesMap = buildReverseEdges(edges);

    function findRealSource(id) {
        let curr = id;
        const visited = new Set();
        while (String(curr).startsWith("dummy|") && !visited.has(curr)) {
            visited.add(curr);
            const prev = reverseEdgesMap.get(curr);
            if (prev && prev.length > 0) {
                curr = prev[0];
            } else {
                const parts = String(curr).split("|");
                if (parts.length >= 2) curr = parts[1];
                break;
            }
        }
        return curr;
    }

    function findRealTarget(id) {
        let curr = id;
        const visited = new Set();
        while (String(curr).startsWith("dummy|") && !visited.has(curr)) {
            visited.add(curr);
            const next = edges.get(curr);
            if (next && next.length > 0) {
                curr = next[0];
            } else {
                const parts = String(curr).split("|");
                if (parts.length >= 3) curr = parts[2];
                break;
            }
        }
        return curr;
    }

    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= levels.length) continue;
        const sourceX = positionsX.get(from);
        if (sourceX === undefined) continue;

        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) continue;
            const targetX = positionsX.get(target);
            if (targetX === undefined) continue;

            const isFromDummy = String(from).startsWith("dummy|");
            const realFrom = isFromDummy ? findRealSource(from) : from;
            const realTo = String(target).startsWith("dummy|") ? findRealTarget(target) : target;

            const edgeObj = {
                fromId: from, toId: target, fromDepth: fromDepth,
                realFromId: realFrom, realToId: realTo,
                isFromDummy: isFromDummy,
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

    linkData.forEach((edge, index) => {
        edge.edgeKey = `${edge.fromId}->${edge.toId}_${index}`;
        edge.source = positions.get(edge.fromId);
        edge.target = positions.get(edge.toId);

        const targetId = edge.realToId || edge.toId;
        const targetPos = positions.get(targetId) || edge.target;
        const hFrom = (nodeDims.get(edge.fromId) || {}).h || 0;
        const hTo = (nodeDims.get(edge.toId) || {}).h || 0;
        const startY = (edge.source ? edge.source.y : 0) + hFrom / 2;
        const endY = (edge.target ? edge.target.y : 0) - hTo / 2;
        const directEndY = (targetPos ? targetPos.y : 0) - ((nodeDims.get(targetId) || {}).h || 0) / 2;

        const sx = edge.source ? edge.source.x : 0;
        const tx = edge.target ? edge.target.x : 0;
        const dtx = targetPos ? targetPos.x : tx;

        edge.bounds = {
            minX: Math.min(sx, tx, dtx) - 16,
            maxX: Math.max(sx, tx, dtx) + 16,
            minY: Math.min(startY, endY, directEndY) - 16,
            maxY: Math.max(startY, endY, directEndY) + 16
        };
    });

    const svgHeightComputed = depthY[levels.length - 1] + maxIndividualHeight / 2 + margin.bottom;

    // 7. Calculate precise Layout Boundaries
    const folderY = new Map();
    const fileY = new Map();

    orderedFolders.forEach(folder => folderY.set(folder, { minY: Infinity, maxY: -Infinity }));
    fileOrder.forEach(f => fileY.set(f, { minY: Infinity, maxY: -Infinity }));

    nodeData.forEach((d) => {
        if (d.isDummy) return;
        const pos = positions.get(d.id);
        if (!pos) return;
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
    const folderBoxData = [];
    const fileBoxData = [];

    orderedFolders.forEach((folder) => {
        if (!folder) return;
        const files = orderedFilesByFolder.get(folder) || [];
        if (files.length === 0) return;
        const yRange = folderY.get(folder);
        if (yRange.minY === Infinity) return;

        const isCollapsed = collapsedFolders.has(folder);

        // Folder box spans all distinct slot positions its files occupy
        let folderMinX = Infinity, folderMaxX = -Infinity;
        files.forEach(f => {
            const fiBox = fileY.get(f);
            if (!fiBox || fiBox.minY === Infinity) return;
            const sx = fileStartX.get(f);
            if (sx === undefined) return;
            const slotIdx = fileToSlot.get(f);
            const sw = (slotIdx !== undefined) ? slotWidths[slotIdx] : COLLAPSED_WIDTH;
            const fileW = isCollapsed ? COLLAPSED_WIDTH : (collapsedFiles.has(f) ? COLLAPSED_WIDTH : sw);
            folderMinX = Math.min(folderMinX, sx);
            folderMaxX = Math.max(folderMaxX, sx + fileW);
        });
        if (folderMinX === Infinity) return;

        folderBoxData.push({
            folder,
            x: folderMinX - boxPadding,
            y: yRange.minY - 40,
            width: folderMaxX - folderMinX + 2 * boxPadding,
            height: yRange.maxY - yRange.minY + 60,
            color: getFolderColor(folder),
            collapsed: isCollapsed
        });
    });

    fileOrder.forEach((f) => {
        const meta = fileMetaByKey.get(f);
        if (!meta) return;
        const yRange = fileY.get(f);
        if (yRange.minY === Infinity) return;

        // Hide file boxes completely if parent folder is collapsed
        if (meta.folder && collapsedFolders.has(meta.folder)) return;

        const isCollapsed = collapsedFiles.has(f);
        const minX = fileStartX.get(f);
        const slotIdx = fileToSlot.get(f);
        const slotW = (slotIdx !== undefined) ? slotWidths[slotIdx] : (fileColumnWidths.get(f) || 0);
        const widthX = isCollapsed ? COLLAPSED_WIDTH : slotW;
        const maxX = minX + widthX;
        const label = meta.file ? meta.file : f;

        fileBoxData.push({
            file: f, label,
            x: minX - boxPadding,
            y: yRange.minY - 20,
            width: maxX - minX + 2 * boxPadding,
            height: yRange.maxY - yRange.minY + 40,
            color: getFileColor(f),
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
                if (!d.isDummy && d.folder === box.folder) nodeContainerBounds.set(d.id, { isCollapsed: true, leftX: box.x, rightX: box.x + box.width });
            });
        }
    });

    fileBoxData.forEach(box => {
        if (box.collapsed && !collapsedFolders.has(fileMetaByKey.get(box.file).folder)) {
            nodeData.forEach(d => {
                if (!d.isDummy && d.fileKey === box.file) nodeContainerBounds.set(d.id, { isCollapsed: true, leftX: box.x, rightX: box.x + box.width });
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

    // SVG Defs for highlights
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

    const filterEmerald = svgDefs.append("filter")
        .attr("id", "glow-emerald")
        .attr("x", "-30%").attr("y", "-30%")
        .attr("width", "160%").attr("height", "160%");
    filterEmerald.append("feDropShadow")
        .attr("dx", "0").attr("dy", "2")
        .attr("stdDeviation", "5")
        .attr("flood-color", "#059669")
        .attr("flood-opacity", "0.65");

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

    // Phase 2: Index edges by node ID for O(1) interaction lookups
    const edgesByNodeId = new Map();
    function indexEdge(id, edgeObj) {
        if (!id) return;
        let list = edgesByNodeId.get(id);
        if (!list) {
            list = [];
            edgesByNodeId.set(id, list);
        }
        list.push(edgeObj);
    }

    linkData.forEach((d) => {
        indexEdge(d.fromId, d);
        indexEdge(d.toId, d);
        if (d.realFromId && d.realFromId !== d.fromId) indexEdge(d.realFromId, d);
        if (d.realToId && d.realToId !== d.toId) indexEdge(d.realToId, d);
    });
    state.edgesByNodeId = edgesByNodeId;

    container.node().updateEdgeRouting = function() {
        const isOrthogonal = document.getElementById("toggle-orthogonal")?.checked;
        edgesGroup.selectAll("path.graph-edge").attr("d", (d) => buildPathLine(d, nodeDims, isOrthogonal));
        if (typeof container.node().updateViewportCulling === "function") {
            container.node().updateViewportCulling(true);
        }
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
        if (!useOrthogonal) {
            // When edge style is not orthogonal, dummy nodes should not create intersections or extra segments.
            // The edge originating from a real node connects directly to the final real target.
            // Subsequent segments in the dummy chain are not drawn.
            if (d.isFromDummy) return "";

            const targetId = d.realToId || d.toId;
            const targetPos = positions.get(targetId) || d.target;
            const hFrom = (nodeDims.get(d.fromId) || {}).h || 0;
            const hTo = (nodeDims.get(targetId) || {}).h || 0;

            let startX = d.source.x;
            let startY = d.source.y + (hFrom / 2);
            let endX = targetPos.x;
            let endY = targetPos.y - (hTo / 2);

            const srcBounds = nodeContainerBounds.get(d.fromId);
            const tgtBounds = nodeContainerBounds.get(targetId);

            if (srcBounds && srcBounds.isCollapsed) {
                if (endX > startX) startX = srcBounds.rightX;
                else if (endX < startX) startX = srcBounds.leftX;
            }

            if (tgtBounds && tgtBounds.isCollapsed) {
                if (startX > endX) endX = tgtBounds.rightX;
                else if (startX < endX) endX = tgtBounds.leftX;
            }

            return `M ${startX} ${startY} L ${endX} ${endY}`;
        } else {
            const hFrom = (nodeDims.get(d.fromId) || {}).h || 0;
            const hTo = (nodeDims.get(d.toId) || {}).h || 0;

            let startX = d.source.x;
            let startY = d.source.y + (hFrom / 2);
            let endX = d.target.x;
            let endY = d.target.y - (hTo / 2);

            const srcBounds = nodeContainerBounds.get(d.fromId);
            const tgtBounds = nodeContainerBounds.get(d.toId);

            if (srcBounds && srcBounds.isCollapsed) {
                if (d.target.x > d.source.x) startX = srcBounds.rightX;
                else if (d.target.x < d.source.x) startX = srcBounds.leftX;
            }

            if (tgtBounds && tgtBounds.isCollapsed) {
                if (d.source.x > d.target.x) endX = tgtBounds.rightX;
                else if (d.source.x < d.target.x) endX = tgtBounds.leftX;
            }

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

    const isTabNode = (d) => {
        if (focusNodeId) return d.id === focusNodeId;
        return !!(state.activeTabNodeId && d.id === state.activeTabNodeId);
    };

    const isRootNode = (d) => {
        if (focusNodeId) return false;
        return d.depth === 0 && (!state.activeTabNodeId || d.id !== state.activeTabNodeId);
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
        if (isTabNode(d)) return "#059669"; // Active tab's selected node: unique emerald green
        if (isRootNode(d)) return "#2563eb";
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
        if (isTabNode(d)) return "#047857"; // Deep emerald green border
        return "#94a3b8";
    };

    const getNodeRectStrokeWidth = (d) => {
        const mt = getNodeMatchType(d);
        if (mt) {
            if (d.id === activeMatchId) return 3.5;
            return 2.5;
        }
        if (isTabNode(d)) return 2.5;
        return 1;
    };

    const getNodeFilter = (d) => {
        if (isSearchActive) {
            if (d.id === activeMatchId) return "url(#glow-active)";
            if (getNodeMatchType(d)) return "url(#glow-amber)";
        }
        if (isTabNode(d)) return "url(#glow-emerald)";
        return null;
    };

    const getNodeTextFill = (d) => {
        const mt = getNodeMatchType(d);
        if (mt) {
            if (d.id === activeMatchId) return "#ffffff";
            if (mt === "function") return "#0f172a"; // Deep bold black text on vivid amber gold
            if (mt === "file" || mt === "folder") return "#ffffff";
        }
        if (isTabNode(d)) return "#ffffff";
        if (isRootNode(d)) return "#f8fafc";
        return "#1f2937";
    };

    const getNodeClass = (d) => {
        const mt = getNodeMatchType(d);
        let cls = "node-g";
        if (mt) {
            cls += ` search-match search-match-${mt}`;
            if (d.id === activeMatchId) cls += " search-match-active";
        }
        if (isTabNode(d)) cls += " node-active-tab";
        return cls;
    };

    function appendNodeText(selection) {
        const textNodes = selection.append("text")
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
                isTabNode: isTabNode(d),
                width: d.width
            })))
            .enter().append("tspan")
            .attr("x", d => d.width / 2).attr("dy", (_, i) => (i === 0 ? 0 : 16))
            .attr("font-weight", d => {
                if (d.isActiveMatch) return "800";
                if (d.matchType === "function" && d.isFuncLine) return "800";
                if (d.matchType) return "700";
                if (d.isTabNode) return (d.isFuncLine ? "800" : "700");
                return "normal";
            })
            .text(d => d.line);
    }

    const nodesGroup = mainGroup.append("g").attr("class", "nodes");

    // Phase 1: Spatial indexes for high-performance viewport culling
    const spatialNodeIndex = new SpatialIndex(600);
    visibleNodeData.forEach(d => {
        const pos = positions.get(d.id);
        if (!pos) return;
        const halfW = d.width / 2;
        const halfH = d.height / 2;
        d.bounds = {
            minX: pos.x - halfW,
            maxX: pos.x + halfW,
            minY: pos.y - halfH,
            maxY: pos.y + halfH
        };
        spatialNodeIndex.insert(d, d.bounds.minX, d.bounds.minY, d.bounds.maxX, d.bounds.maxY);
    });

    const spatialEdgeIndex = new SpatialIndex(600);
    linkData.forEach(d => {
        if (d.bounds) {
            spatialEdgeIndex.insertSampled(d, d.bounds.minX, d.bounds.minY, d.bounds.maxX, d.bounds.maxY);
        }
    });

    const nodeElementsById = new Map();
    state.nodeElementsById = nodeElementsById;

    if (isSearchActive) {
        svg.classed("has-search-active", true);
    } else {
        svg.classed("has-search-active", false);
    }

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

    attachInteractions(nodesGroup, edgesGroup, edges, svg, state, {
        getNodeRectFill,
        getNodeRectStroke,
        getNodeRectStrokeWidth,
        getNodeFilter,
        getNodeTextFill,
        isTabNode
    }, options, container, nodeElementsById, edgesByNodeId);

    // --- High-Performance Viewport Culling Engine (Phase 1) ---
    function updateViewportCulling(force = false) {
        const transform = state.currentZoomTransform || d3.zoomIdentity;
        const k = transform.k || 1;
        const vpW = (containerNode && containerNode.clientWidth > 0) ? containerNode.clientWidth : fallbackWidth;
        const vpH = (containerNode && containerNode.clientHeight > 0) ? containerNode.clientHeight : viewportHeight;

        const isSmallGraph = visibleNodeData.length <= 150;
        const showText = isSmallGraph || (k >= 0.16);

        let culledNodes, culledEdges;
        const isOrthogonal = document.getElementById("toggle-orthogonal")?.checked;

        if (isSmallGraph) {
            culledNodes = visibleNodeData;
            culledEdges = isOrthogonal ? linkData : linkData.filter(e => !e.isFromDummy);
        } else {
            const bufferX = Math.max(350, vpW * 0.5) / k;
            const bufferY = Math.max(350, vpH * 0.5) / k;
            // Clamp the query rectangle to the layout bounding box (plus a small
            // margin). Without this, zooming out makes the proportional buffer
            // enormous and every cull scans hundreds of thousands of empty grid
            // cells while allocating a string key per cell.
            const viewMinX = Math.max(gMinX - 64, -transform.x / k - bufferX);
            const viewMaxX = Math.min(gMaxX + 64, (vpW - transform.x) / k + bufferX);
            const viewMinY = Math.max(gMinY - 64, -transform.y / k - bufferY);
            const viewMaxY = Math.min(gMaxY + 64, (vpH - transform.y) / k + bufferY);

            if (viewMinX > viewMaxX || viewMinY > viewMaxY) {
                culledNodes = [];
                culledEdges = [];
            } else {
                culledNodes = spatialNodeIndex.query(viewMinX, viewMinY, viewMaxX, viewMaxY);
                const rawCulledEdges = spatialEdgeIndex.query(viewMinX, viewMinY, viewMaxX, viewMaxY);
                culledEdges = isOrthogonal ? rawCulledEdges : rawCulledEdges.filter(e => !e.isFromDummy);
            }
        }

        const highlight = (state.getActiveHighlight && state.getActiveHighlight()) || {};
        const curActiveSet = highlight.activeSet;
        const curPrimaryId = highlight.primaryId;

        // --- 1. Nodes Enter / Update / Exit ---
        const nodeSel = nodesGroup.selectAll("g.node-g")
            .data(culledNodes, d => d.id);

        nodeSel.exit().each(function(d) {
            if (d) {
                d._domEl = null;
                d._hasText = false;
                nodeElementsById.delete(d.id);
            }
        }).remove();

        const enteredNodes = nodeSel.enter().append("g")
            .attr("class", d => getNodeClass(d))
            .attr("transform", (d) => {
                const position = positions.get(d.id);
                return `translate(${position.x - d.width / 2}, ${position.y - d.height / 2})`;
            });

        enteredNodes.append("rect")
            .attr("class", "node-rect")
            .attr("width", d => d.width).attr("height", d => d.height)
            .attr("rx", 6)
            .attr("fill", d => getNodeRectFill(d))
            .attr("stroke", d => getNodeRectStroke(d))
            .attr("stroke-width", d => getNodeRectStrokeWidth(d))
            .attr("filter", d => getNodeFilter(d));

        enteredNodes.filter(d => isTabNode(d))
            .append("rect")
            .attr("class", "active-tab-ring")
            .attr("x", -3).attr("y", -3)
            .attr("width", d => d.width + 6).attr("height", d => d.height + 6)
            .attr("rx", 8)
            .attr("fill", "none")
            .attr("stroke", "#10b981")
            .attr("stroke-width", 2)
            .attr("stroke-dasharray", "4,2")
            .style("pointer-events", "none");

        enteredNodes.filter(d => d.id === activeMatchId)
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

        if (showText) {
            appendNodeText(enteredNodes);
        }

        enteredNodes.each(function(d) {
            d._domEl = this;
            d._hasText = showText;
            nodeElementsById.set(d.id, { el: this, d });

            if (curActiveSet && curActiveSet.has(d.id)) {
                if (d.id === curPrimaryId) {
                    this.classList.add("node-primary-highlight");
                } else {
                    this.classList.add("node-connected-highlight");
                }
            }
        });

        // LOD text reconciliation for existing nodes
        nodeSel.each(function(d) {
            if (showText && !d._hasText) {
                appendNodeText(d3.select(this));
                d._hasText = true;
            } else if (!showText && d._hasText) {
                d3.select(this).select("text.node-text").remove();
                d._hasText = false;
            }
        });

        // --- 2. Edges Enter / Update / Exit ---
        const edgeSel = edgesGroup.selectAll("path.graph-edge")
            .data(culledEdges, d => d.edgeKey);

        edgeSel.exit().each(function(d) {
            if (d) d._domEl = null;
        }).remove();

        const enteredEdges = edgeSel.enter().append("path")
            .attr("class", "graph-edge")
            .attr("fill", "none").attr("stroke", "#94a3b8").attr("stroke-width", 1)
            .attr("d", d => buildPathLine(d, nodeDims, isOrthogonal));

        enteredEdges.each(function(d) {
            d._domEl = this;
            if (curActiveSet) {
                const isConnectedToPrimary = curPrimaryId && (
                    d.fromId === curPrimaryId || d.toId === curPrimaryId ||
                    d.realFromId === curPrimaryId || d.realToId === curPrimaryId
                );
                const isConnectedInActiveSet = (
                    (curActiveSet.has(d.fromId) && curActiveSet.has(d.toId)) ||
                    (d.realFromId && d.realToId && curActiveSet.has(d.realFromId) && curActiveSet.has(d.realToId))
                );

                if (isConnectedToPrimary) {
                    this.classList.add("edge-primary-highlight");
                } else if (isConnectedInActiveSet) {
                    this.classList.add("edge-connected-highlight");
                }
            }
        });
    }

    let cullingRafId = null;
    function scheduleCulling() {
        if (cullingRafId) return;
        cullingRafId = requestAnimationFrame(() => {
            cullingRafId = null;
            updateViewportCulling(false);
        });
    }

    container.node().updateViewportCulling = updateViewportCulling;
    state.updateViewportCulling = updateViewportCulling;

    if (window.ResizeObserver && containerNode) {
        if (containerNode._navResizeObserver) {
            containerNode._navResizeObserver.disconnect();
        }
        const ro = new ResizeObserver(() => {
            updateNavButton();
            if (typeof container.node().updateViewportCulling === "function") {
                container.node().updateViewportCulling(true);
            }
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
                updateViewportCulling(true);
            });
    };

    // --- Interaction Attachments & Zoom ---
    const zoom = d3.zoom()
        .scaleExtent([0.05, 5])
        .on("zoom", (event) => {
            state.currentZoomTransform = event.transform;
            mainGroup.attr("transform", event.transform);
            updateNavButton();
            scheduleCulling();
        })
        .on("end", () => {
            if (cullingRafId) {
                cancelAnimationFrame(cullingRafId);
                cullingRafId = null;
            }
            updateViewportCulling(true);
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

    // Initial render of culled viewport elements
    updateViewportCulling(true);

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
                .call(zoom.transform, targetTransform)
                .on("end", () => {
                    updateViewportCulling(true);
                });
        } else {
            svg.call(zoom.transform, targetTransform);
            updateViewportCulling(true);
        }
    }
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
    children.forEach(child => {
        if (String(child).startsWith("dummy|")) {
            let realTgt = child;
            const visited = new Set();
            while (String(realTgt).startsWith("dummy|") && !visited.has(realTgt)) {
                visited.add(realTgt);
                const next = edges.get(realTgt);
                if (next && next.length > 0) realTgt = next[0];
                else break;
            }
            if (String(realTgt).startsWith("dummy|")) {
                const parts = String(child).split("|");
                if (parts.length >= 3) realTgt = parts[2];
            }
            connected.add(realTgt);
        } else {
            connected.add(child);
        }
    });
    const parents = reverseEdges.get(nodeId) || [];
    parents.forEach(parent => {
        if (String(parent).startsWith("dummy|")) {
            let realSrc = parent;
            const visited = new Set();
            while (String(realSrc).startsWith("dummy|") && !visited.has(realSrc)) {
                visited.add(realSrc);
                const prev = reverseEdges.get(realSrc);
                if (prev && prev.length > 0) realSrc = prev[0];
                else break;
            }
            if (String(realSrc).startsWith("dummy|")) {
                const parts = String(parent).split("|");
                if (parts.length >= 2) realSrc = parts[1];
            }
            connected.add(realSrc);
        } else {
            connected.add(parent);
        }
    });
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

function attachInteractions(nodesGroup, edgesGroup, edgesMap, svgEl, state, styleHelpers, options, container, nodeElementsById, edgesByNodeId) {
    const reverseEdgesMap = buildReverseEdges(edgesMap);
    let activeClickedNodeId = (state && state.activeClickedNodeId) || null;
    let currentActiveSet = null;
    let currentPrimaryId = null;

    const isDimEnabled = () => window.dimHighlightEnabled !== false;

    // True when the pointer moved from one interactive graph element to another
    // (node <-> node or node <-> edge). In that case the upcoming mouseover will
    // immediately replace the highlight, so we must NOT tear the highlight down
    // in between: doing so toggles the global `has-highlight` dimming class twice
    // per move, forcing thousands of opacity transitions and style recalcs.
    function movedWithinGraph(relatedTarget) {
        return !!(relatedTarget && relatedTarget.closest && relatedTarget.closest(".node-g, .graph-edge"));
    }

    function updateHighlightState(activeSet, primaryId) {
        // 1. Clear the previous highlight directly in the DOM. Querying the
        //    visible selection avoids retaining references to elements that the
        //    viewport-culling engine has since removed (a detached-DOM leak), and
        //    is bounded by what is actually rendered at this moment.
        if (currentActiveSet) {
            nodesGroup.selectAll(".node-primary-highlight").classed("node-primary-highlight", false);
            nodesGroup.selectAll(".node-connected-highlight").classed("node-connected-highlight", false);
            edgesGroup.selectAll(".edge-primary-highlight").classed("edge-primary-highlight", false);
            edgesGroup.selectAll(".edge-connected-highlight").classed("edge-connected-highlight", false);
        }

        currentActiveSet = activeSet;
        currentPrimaryId = primaryId;

        // If no activeSet, remove highlight classes and exit
        if (!activeSet) {
            svgEl.classed("has-highlight", false);
            return;
        }

        // 2. Mark SVG with highlight & dimming classes (handled natively by CSS)
        svgEl.classed("has-highlight", true);
        svgEl.classed("dim-enabled", isDimEnabled());

        // 3. Highlight primary node
        if (primaryId) {
            const primaryObj = nodeElementsById.get(primaryId);
            if (primaryObj && primaryObj.el) {
                primaryObj.el.classList.add("node-primary-highlight");
                // Bring only the primary node to the front so it stands out above overlapping boxes
                if (primaryObj.el.parentNode) {
                    primaryObj.el.parentNode.appendChild(primaryObj.el);
                }
            }
        }

        // 4. Highlight connected nodes
        for (const nodeId of activeSet) {
            if (nodeId !== primaryId) {
                const nodeObj = nodeElementsById.get(nodeId);
                if (nodeObj && nodeObj.el) {
                    nodeObj.el.classList.add("node-connected-highlight");
                }
            }
        }

        // 6. Highlight edges touching activeSet (indexed lookups)
        const candidateEdges = new Set();
        if (primaryId) {
            const pEdges = edgesByNodeId.get(primaryId);
            if (pEdges) {
                for (let i = 0; i < pEdges.length; i++) candidateEdges.add(pEdges[i]);
            }
        }
        for (const nodeId of activeSet) {
            const nEdges = edgesByNodeId.get(nodeId);
            if (nEdges) {
                for (let i = 0; i < nEdges.length; i++) candidateEdges.add(nEdges[i]);
            }
        }

        for (const edgeObj of candidateEdges) {
            const d = edgeObj.d || edgeObj;
            const el = edgeObj.el || edgeObj._domEl;
            if (!el) continue;
            const isConnectedToPrimary = primaryId && (
                d.fromId === primaryId || d.toId === primaryId ||
                d.realFromId === primaryId || d.realToId === primaryId
            );
            const isConnectedInActiveSet = (
                (activeSet.has(d.fromId) && activeSet.has(d.toId)) ||
                (d.realFromId && d.realToId && activeSet.has(d.realFromId) && activeSet.has(d.realToId))
            );

            if (isConnectedToPrimary) {
                el.classList.add("edge-primary-highlight");
            } else if (isConnectedInActiveSet) {
                el.classList.add("edge-connected-highlight");
            }
        }
    }

    state.getActiveHighlight = () => ({
        activeSet: currentActiveSet,
        primaryId: currentPrimaryId
    });
    state.updateHighlightState = updateHighlightState;

    // Restore active clicked node or search state
    if (activeClickedNodeId && nodeElementsById.has(activeClickedNodeId)) {
        const allConnected = window.getFullAllConnected ?
            window.getFullAllConnected(activeClickedNodeId) :
            getAllConnected(activeClickedNodeId, edgesMap, reverseEdgesMap);
        updateHighlightState(allConnected, activeClickedNodeId);
    } else {
        activeClickedNodeId = null;
        if (state) state.activeClickedNodeId = null;
        updateHighlightState(null, null);
    }

    // --- High-Performance Event Delegation on Nodes Group ---
    nodesGroup
        .on("mouseover", function(event) {
            if (activeClickedNodeId) return;
            const nodeG = event.target.closest(".node-g");
            if (!nodeG) return;
            if (event.relatedTarget && event.relatedTarget.closest(".node-g") === nodeG) return;

            const d = nodeG.__data__;
            if (!d) return;

            const immediateNeighbors = window.getFullImmediateNeighbors ?
                window.getFullImmediateNeighbors(d.id) :
                getImmediateNeighbors(d.id, edgesMap, reverseEdgesMap);
            updateHighlightState(immediateNeighbors, d.id);
            if (options && typeof options.onNodeHover === "function") {
                options.onNodeHover(d.id, immediateNeighbors);
            }
        })
        .on("mouseout", function(event) {
            if (activeClickedNodeId) return;
            const nodeG = event.target.closest(".node-g");
            if (!nodeG) return;
            if (event.relatedTarget && event.relatedTarget.closest(".node-g") === nodeG) return;
            if (movedWithinGraph(event.relatedTarget)) return;

            updateHighlightState(null, null);
            if (options && typeof options.onNodeMouseOut === "function") {
                options.onNodeMouseOut();
            }
        })
        .on("click", function(event) {
            const nodeG = event.target.closest(".node-g");
            if (!nodeG) return;
            const d = nodeG.__data__;
            if (!d) return;

            if (activeClickedNodeId === d.id) {
                activeClickedNodeId = null;
                if (state) state.activeClickedNodeId = null;
                updateHighlightState(null, null);
                if (options && typeof options.onNodeClick === "function") {
                    options.onNodeClick(null, null);
                }
            } else {
                activeClickedNodeId = d.id;
                if (state) state.activeClickedNodeId = d.id;
                const allConnected = window.getFullAllConnected ?
                    window.getFullAllConnected(d.id) :
                    getAllConnected(d.id, edgesMap, reverseEdgesMap);
                updateHighlightState(allConnected, d.id);
                if (options && typeof options.onNodeClick === "function") {
                    options.onNodeClick(d.id, allConnected);
                }
            }
            event.stopPropagation();
        })
        .on("contextmenu", function(event) {
            const nodeG = event.target.closest(".node-g");
            if (!nodeG) return;
            const d = nodeG.__data__;
            if (!d || d.isDummy) return;

            event.preventDefault();
            event.stopPropagation();

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

    // --- High-Performance Event Delegation on Edges Group ---
    edgesGroup
        .on("mouseover", function(event) {
            if (activeClickedNodeId) return;
            const edgePath = event.target.closest(".graph-edge");
            if (!edgePath) return;
            if (event.relatedTarget && event.relatedTarget.closest(".graph-edge") === edgePath) return;

            const d = edgePath.__data__;
            if (!d) return;

            const origin = d.realFromId || d.fromId;
            const target = d.realToId || d.toId;
            const activeSet = new Set([origin, target]);
            const siblings = edgesMap.get(origin) || [];
            siblings.forEach(targetId => {
                if (String(targetId).startsWith("dummy|")) {
                    const realTgt = String(targetId).split("|")[2];
                    if (realTgt) activeSet.add(realTgt);
                } else {
                    activeSet.add(targetId);
                }
            });

            updateHighlightState(activeSet, origin);
            if (options && typeof options.onNodeHover === "function") {
                options.onNodeHover(origin, activeSet);
            }
        })
        .on("mouseout", function(event) {
            if (activeClickedNodeId) return;
            const edgePath = event.target.closest(".graph-edge");
            if (!edgePath) return;
            if (event.relatedTarget && event.relatedTarget.closest(".graph-edge") === edgePath) return;
            if (movedWithinGraph(event.relatedTarget)) return;

            updateHighlightState(null, null);
            if (options && typeof options.onNodeMouseOut === "function") {
                options.onNodeMouseOut();
            }
        });

    svgEl.on("click", (event) => {
        if (event && event.defaultPrevented) return;
        if (activeClickedNodeId) {
            activeClickedNodeId = null;
            if (state) state.activeClickedNodeId = null;
            updateHighlightState(null, null);
            if (options && typeof options.onNodeClick === "function") {
                options.onNodeClick(null, null);
            }
        }
        // Hide context menu on background click
        const ctxMenu = document.getElementById("context-menu");
        if (ctxMenu) ctxMenu.style.display = "none";
    });

    if (container && container.node()) {
        const cNode = container.node();
        cNode.highlightNodeHover = function(nodeId, passedActiveSet) {
            if (activeClickedNodeId) return;
            if (!nodeId) {
                updateHighlightState(null, null);
                return;
            }
            const activeSet = passedActiveSet || (
                window.getFullImmediateNeighbors ?
                    window.getFullImmediateNeighbors(nodeId) :
                    getImmediateNeighbors(nodeId, edgesMap, reverseEdgesMap)
            );
            updateHighlightState(activeSet, nodeId);
        };

        cNode.clearNodeHover = function() {
            if (activeClickedNodeId) {
                const allConnected = window.getFullAllConnected ?
                    window.getFullAllConnected(activeClickedNodeId) :
                    getAllConnected(activeClickedNodeId, edgesMap, reverseEdgesMap);
                updateHighlightState(allConnected, activeClickedNodeId);
            } else {
                updateHighlightState(null, null);
            }
        };

        cNode.selectNode = function(nodeId, passedActiveSet) {
            if (!nodeId || activeClickedNodeId === nodeId) {
                activeClickedNodeId = null;
                if (state) state.activeClickedNodeId = null;
                updateHighlightState(null, null);
                return;
            }

            // Uncollapse if collapsed
            let uncollapsed = false;
            if (state && state.currentGraphData && state.currentGraphData.nodes) {
                const rawLabel = state.currentGraphData.nodes.get(nodeId);
                if (rawLabel) {
                    const info = parseNodeLabel(rawLabel);
                    const fileKey = makeFileKey(info.folder, info.file);
                    if (info.folder && state.collapsedFolders.has(info.folder)) {
                        state.collapsedFolders.delete(info.folder);
                        uncollapsed = true;
                    }
                    if (fileKey && state.collapsedFiles.has(fileKey)) {
                        state.collapsedFiles.delete(fileKey);
                        uncollapsed = true;
                    }
                }
            }

            if (uncollapsed) {
                state.activeClickedNodeId = nodeId;
                renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, {
                    ...options,
                    collapseAllOnInit: false
                });
                return;
            }

            activeClickedNodeId = nodeId;
            if (state) state.activeClickedNodeId = nodeId;
            const allConnected = passedActiveSet || (
                window.getFullAllConnected ?
                    window.getFullAllConnected(nodeId) :
                    getAllConnected(nodeId, edgesMap, reverseEdgesMap)
            );
            updateHighlightState(allConnected, nodeId);
        };

        cNode.setActiveTabNode = function(nodeId) {
            if (state) state.activeTabNodeId = nodeId;

            // Uncollapse folder/file on left if nodeId is collapsed
            let uncollapsed = false;
            if (nodeId && state && state.currentGraphData && state.currentGraphData.nodes) {
                const rawLabel = state.currentGraphData.nodes.get(nodeId);
                if (rawLabel) {
                    const info = parseNodeLabel(rawLabel);
                    const fileKey = makeFileKey(info.folder, info.file);
                    if (info.folder && state.collapsedFolders.has(info.folder)) {
                        state.collapsedFolders.delete(info.folder);
                        uncollapsed = true;
                    }
                    if (fileKey && state.collapsedFiles.has(fileKey)) {
                        state.collapsedFiles.delete(fileKey);
                        uncollapsed = true;
                    }
                }
            }

            if (uncollapsed) {
                renderGraph(state.currentGraphData.levels, state.currentGraphData.depthById, state.currentGraphData.nodes, state.currentGraphData.edges, container, state, {
                    ...options,
                    collapseAllOnInit: false
                });
                return;
            }

            // Update tab highlight ring in-place
            if (nodesGroup) {
                nodesGroup.selectAll(".node-active-tab").classed("node-active-tab", false);
                nodesGroup.selectAll(".active-tab-ring").remove();

                if (nodeId && nodeElementsById.has(nodeId)) {
                    const targetObj = nodeElementsById.get(nodeId);
                    d3.select(targetObj.el).classed("node-active-tab", true);
                    const d = targetObj.d;
                    d3.select(targetObj.el).append("rect")
                        .attr("class", "active-tab-ring")
                        .attr("x", -3).attr("y", -3)
                        .attr("width", d.width + 6).attr("height", d.height + 6)
                        .attr("rx", 8)
                        .attr("fill", "none")
                        .attr("stroke", "#10b981")
                        .attr("stroke-width", 2)
                        .attr("stroke-dasharray", "4,2")
                        .style("pointer-events", "none");
                }
            }

            if (activeClickedNodeId) {
                const allConnected = window.getFullAllConnected ?
                    window.getFullAllConnected(activeClickedNodeId) :
                    getAllConnected(activeClickedNodeId, edgesMap, reverseEdgesMap);
                updateHighlightState(allConnected, activeClickedNodeId);
            } else {
                updateHighlightState(null, null);
            }
        };

        cNode.refreshHighlight = function() {
            updateHighlightState(currentActiveSet, currentPrimaryId);
        };
    }
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

    // Remove old active pulse rings and class in O(1)
    nodesGroup.selectAll(".search-active-pulse").remove();
    nodesGroup.selectAll(".search-match-active").classed("search-match-active", false);

    // Highlight only the new active match
    const targetObj = state.nodeElementsById?.get(targetId);
    if (targetObj && targetObj.el) {
        const g = d3.select(targetObj.el);
        g.classed("search-match-active", true);
        const d = targetObj.d;
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
    }

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