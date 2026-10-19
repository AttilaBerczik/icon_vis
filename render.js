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

// --- Edge thickness (call frequency) --------------------------------------
// Edges carry `weight=<number of call sites>` (parsed in parser.js). When the
// "Thick Edges" toggle is on, the base stroke width is scaled logarithmically
// with the weight so that frequently-called links stand out. The bounds live in
// constants.js (EDGE_WIDTH_MIN / EDGE_WIDTH_MAX).

function isEdgeThicknessEnabled() {
    return window.edgeThicknessEnabled !== false;
}

function getEdgeWeightForIds(fromId, toId) {
    const map = window.globalEdgeWeightMap;
    if (!map || fromId == null || toId == null) return 1;
    let w = map.get(fromId + "|" + toId);
    if (w === undefined) w = map.get(toId + "|" + fromId); // caller view is flipped
    return (typeof w === "number" && w > 0) ? w : 1;
}

function edgeWeightForData(d) {
    if (!d) return 1;
    const from = d.realFromId || d.fromId;
    const to = d.realToId || d.toId;
    return getEdgeWeightForIds(from, to);
}

function computeEdgeStrokeWidth(d) {
    if (!isEdgeThicknessEnabled()) return EDGE_WIDTH_MIN;
    const w = edgeWeightForData(d);
    const maxW = window.globalMaxEdgeWeight || 1;
    if (w <= 1 || maxW <= 1) return EDGE_WIDTH_MIN;
    const t = Math.log(w) / Math.log(maxW); // 0..1
    return EDGE_WIDTH_MIN + (EDGE_WIDTH_MAX - EDGE_WIDTH_MIN) * t;
}

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
        pendingHoverNodeId: null,
        pendingHoverActiveSet: null,
        // Main-view caller/callee roles anchored to the active side-panel tab.
        roleAnchorId: null,
        roleMap: null,
    };
}

// Classify every node reachable from `anchorId` as a caller (reachable
// backwards), a callee (reachable forwards), or both. Used by the main view so
// its node colours match the focused side-panel graph for the active tab.
function computeRoleMapFromEdges(anchorId, edges, reverseEdges) {
    const roles = new Map();
    if (!anchorId || !edges) return roles;

    const forward = new Set();
    const backward = new Set();

    const walk = (nextMap, out) => {
        const seen = new Set([anchorId]);
        const stack = [anchorId];
        while (stack.length) {
            const current = stack.pop();
            const nexts = nextMap.get(current);
            if (!nexts) continue;
            for (const next of nexts) {
                if (seen.has(next)) continue;
                seen.add(next);
                if (!String(next).startsWith("dummy|")) out.add(next);
                stack.push(next);
            }
        }
    };

    walk(edges, forward);
    walk(reverseEdges || buildReverseEdges(edges), backward);

    const all = new Set([...forward, ...backward]);
    for (const id of all) {
        const isCallee = forward.has(id);
        const isCaller = backward.has(id);
        roles.set(id, isCallee && isCaller ? "both" : (isCallee ? "callee" : "caller"));
    }
    return roles;
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
    // All layout / appearance values live in constants.js.
    const margin = focusNodeId
        ? { top: FOCUS_GRAPH_MARGIN, right: FOCUS_GRAPH_MARGIN, bottom: FOCUS_GRAPH_MARGIN, left: FOCUS_GRAPH_MARGIN }
        : { top: GRAPH_MARGIN, right: GRAPH_MARGIN, bottom: GRAPH_MARGIN, left: GRAPH_MARGIN };

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
            const calculatedWidth = isDummy ? 0 : Math.max(NODE_MIN_WIDTH, localMaxLineLength * NODE_CHAR_WIDTH + NODE_PADDING_X);
            const calculatedHeight = isDummy ? 0 : Math.max(NODE_MIN_HEIGHT, lines.length * NODE_LINE_HEIGHT + NODE_PADDING_Y);

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
    // A file column must be wide enough for the widest *row* it contains. Use the
    // real node widths of that row instead of `count * widestNode`, which
    // over-estimated the width and left dead horizontal space in the column.
    const maxNodesPerLevelByFile = new Map();
    const fileColumnWidths = new Map();

    fileOrder.forEach((f) => {
        maxNodesPerLevelByFile.set(f, 0);
        fileColumnWidths.set(f, 0);
    });

    levels.forEach((levelIds) => {
        const rowWidthByFile = new Map();
        const countByFile = new Map();

        levelIds.forEach((id) => {
            if (String(id).startsWith("dummy|")) return;

            const fileKey = getNodeFileKey(id, nodes);
            const dims = nodeDims.get(id);
            const w = dims ? dims.w : NODE_MIN_WIDTH;

            countByFile.set(fileKey, (countByFile.get(fileKey) || 0) + 1);
            rowWidthByFile.set(fileKey, (rowWidthByFile.get(fileKey) || 0) + w);
        });

        for (const [f, c] of countByFile.entries()) {
            maxNodesPerLevelByFile.set(f, Math.max(maxNodesPerLevelByFile.get(f) || 0, c));
            const rowWidth = (rowWidthByFile.get(f) || 0) + (c - 1) * X_SPACING_BETWEEN_NODES;
            fileColumnWidths.set(f, Math.max(fileColumnWidths.get(f) || 0, rowWidth));
        }
    });

    // 2.5. Hierarchical Interval Graph Coloring: pack folders and files into shared column slots
    //
    // Files (and folders) may only share a column slot when their vertical
    // ranges are disjoint. The ranges must be treated as *continuous spans*
    // [minDepth, maxDepth], not as sets of the discrete depths that happen to
    // contain a node: a file with nodes at depths {2, 9} draws a bounding box
    // that covers every row in between, so it visually collides with a file
    // occupying depth 5 even though their depth *sets* are disjoint. Using sets
    // here was what put overlapping boxes into the same column.
    const fileSpan = new Map();
    fileOrder.forEach(f => fileSpan.set(f, null));

    levels.forEach((levelIds, depth) => {
        levelIds.forEach(id => {
            if (String(id).startsWith("dummy|")) return;
            const fileKey = getNodeFileKey(id, nodes);
            if (!fileSpan.has(fileKey)) return;
            const span = fileSpan.get(fileKey);
            if (!span) fileSpan.set(fileKey, { min: depth, max: depth });
            else {
                span.min = Math.min(span.min, depth);
                span.max = Math.max(span.max, depth);
            }
        });
    });

    const folderSpan = new Map();
    orderedFolders.forEach(folder => folderSpan.set(folder, null));

    levels.forEach((levelIds, depth) => {
        levelIds.forEach(id => {
            if (String(id).startsWith("dummy|")) return;
            const folder = getNodeFolder(id, nodes);
            if (!folderSpan.has(folder)) return;
            const span = folderSpan.get(folder);
            if (!span) folderSpan.set(folder, { min: depth, max: depth });
            else {
                span.min = Math.min(span.min, depth);
                span.max = Math.max(span.max, depth);
            }
        });
    });

    // Folder boxes are padded vertically (FOLDER_BOX_PAD_TOP / _BOTTOM), so two
    // folders may only share the same column slots when at least one empty depth
    // row separates their spans. Without this slack their padded boxes overlap
    // vertically even though the spans themselves are disjoint.
    folderSpan.forEach((span, folder) => {
        if (span) folderSpan.set(folder, { min: span.min - 1, max: span.max + 1 });
    });

    const spansOverlap = (a, b) => !!a && !!b && a.min <= b.max && b.min <= a.max;
    // A slot keeps every span placed in it; a new item may join only when its
    // span overlaps none of them. Keeping the individual spans (instead of one
    // merged span) lets a narrow file drop into a genuine gap between two
    // already-packed files.
    const slotConflicts = (slot, span) => slot.spans.some(s => spansOverlap(s, span));

    const hasRealFolders = orderedFolders.some(f => f && f.length > 0);

    let globalSlots = []; // array of { spans: [], files: [] }
    const fileToSlot = new Map(); // fileKey -> globalSlotIndex
    const folderStartSlot = new Map(); // folder -> startSlotIndex

    if (!hasRealFolders) {
        // Flat file mode (e.g. callgraph.dot): pack files directly across column slots
        fileOrder.forEach(f => {
            const span = fileSpan.get(f);
            let assigned = -1;
            for (let s = 0; s < globalSlots.length; s++) {
                if (!slotConflicts(globalSlots[s], span)) {
                    assigned = s;
                    break;
                }
            }
            if (assigned === -1) {
                assigned = globalSlots.length;
                globalSlots.push({ files: [], spans: [] });
            }
            globalSlots[assigned].files.push(f);
            if (span) globalSlots[assigned].spans.push(span);
            fileToSlot.set(f, assigned);
        });
    } else {
        // Hierarchical mode: pack files inside each folder, and pack folders across columns
        const folderInternalSlots = new Map(); // folder -> array of { files: [], spans: [] }

        orderedFolders.forEach(folder => {
            const files = orderedFilesByFolder.get(folder) || [];
            if (files.length === 0) return;

            const isFolderCollapsed = collapsedFolders.has(folder);
            if (isFolderCollapsed) {
                const span = folderSpan.get(folder);
                folderInternalSlots.set(folder, [{ files: files.slice(), spans: span ? [span] : [] }]);
                return;
            }

            const internalSlots = [];
            files.forEach(f => {
                const span = fileSpan.get(f);
                let assigned = -1;
                for (let s = 0; s < internalSlots.length; s++) {
                    if (!slotConflicts(internalSlots[s], span)) {
                        assigned = s;
                        break;
                    }
                }
                if (assigned === -1) {
                    assigned = internalSlots.length;
                    internalSlots.push({ files: [], spans: [] });
                }
                internalSlots[assigned].files.push(f);
                if (span) internalSlots[assigned].spans.push(span);
            });
            folderInternalSlots.set(folder, internalSlots);
        });

        orderedFolders.forEach(folder => {
            const intSlots = folderInternalSlots.get(folder) || [];
            if (intSlots.length === 0) return;
            const K = intSlots.length;
            const fspan = folderSpan.get(folder);

            // Find first starting slot where folder fits across all K consecutive columns
            let startSlot = 0;
            while (true) {
                let fits = true;
                for (let k = 0; k < K; k++) {
                    const sIdx = startSlot + k;
                    if (sIdx < globalSlots.length && slotConflicts(globalSlots[sIdx], fspan)) {
                        fits = false;
                        break;
                    }
                }
                if (fits) break;
                startSlot++;
            }

            while (globalSlots.length < startSlot + K) {
                globalSlots.push({ spans: [], files: [] });
            }

            folderStartSlot.set(folder, startSlot);

            for (let k = 0; k < K; k++) {
                const gSlot = startSlot + k;
                const intSlot = intSlots[k];
                intSlot.files.forEach(f => {
                    globalSlots[gSlot].files.push(f);
                    fileToSlot.set(f, gSlot);
                });
                if (fspan) globalSlots[gSlot].spans.push(fspan);
            }
        });
    }

    if (globalSlots.length === 0) {
        globalSlots.push({ files: [], spans: [] });
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
        currentX += slotWidths[s] + COLUMN_SLOT_GAP;
    }

    const svgWidth = Math.max(MIN_SVG_WIDTH, currentX + margin.right);
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
                    // Left-align this file's row content at the start of its
                    // column slot. Centering it inside a (possibly wider) shared
                    // slot made narrow files float to the right, which produced
                    // the large, varying empty gaps on the left of boxes.
                    let segmentStartX = startX;

                    realIds.forEach((id) => {
                        const dims = nodeDims.get(id);
                        const x = segmentStartX + dims.w / 2;
                        positionsX.set(id, x);
                        segmentStartX += dims.w + X_SPACING_BETWEEN_NODES;
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
    // The vertical gap is the single biggest source of "dead" space in the
    // graph. Only orthogonal routing genuinely needs it: its edges fan out into
    // horizontal lanes between two levels. Straight edges need almost nothing,
    // and hidden edges need nothing at all. So reserve the generous lane space
    // only while orthogonal edges are actually on screen; otherwise fall back to
    // a tight layout that hugs the nodes.
    const edgesVisibleForSpacing = !!(document.getElementById("toggle-edges") && document.getElementById("toggle-edges").checked);
    const orthogonalForSpacing = !!(document.getElementById("toggle-orthogonal") && document.getElementById("toggle-orthogonal").checked);
    const orthogonalEdgesShown = orthogonalForSpacing && edgesVisibleForSpacing;

    const depthY = new Array(levels.length).fill(0);
    let maxIndividualHeight = NODE_MIN_HEIGHT;
    nodeData.forEach(d => { if (d.height > maxIndividualHeight) maxIndividualHeight = d.height; });

    depthY[0] = margin.top + maxIndividualHeight / 2;

    for (let d = 0; d < levels.length - 1; d++) {
        let ySpacing;
        if (orthogonalEdgesShown) {
            const lanes = maxLanesPerLayer[d] || 1;
            const requiredLaneSpace = lanes * MIN_LANE_GAP;
            ySpacing = Math.max(DEFAULT_Y_SPACING, maxIndividualHeight + requiredLaneSpace + Y_SPACING_EXTRA);
        } else {
            ySpacing = Math.max(TIGHT_Y_SPACING, maxIndividualHeight + TIGHT_Y_SPACING_EXTRA);
        }
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

    const folderBoxData = [];
    const fileBoxData = [];

    // Actual horizontal extent of each file's own nodes. Boxes should hug this.
    // A file is placed in a shared column *slot* whose width is the max of all
    // files packed into it. Using the slot width for the box drew narrow files
    // with large, inconsistent side margins, so measure the real content instead.
    const fileContentX = new Map();
    nodeData.forEach((d) => {
        if (d.isDummy) return;
        const x = positionsX.get(d.id);
        if (x === undefined) return;
        let box = fileContentX.get(d.fileKey);
        if (!box) {
            box = { minX: Infinity, maxX: -Infinity };
            fileContentX.set(d.fileKey, box);
        }
        box.minX = Math.min(box.minX, x - d.width / 2);
        box.maxX = Math.max(box.maxX, x + d.width / 2);
    });

    // Horizontal extent to draw for a file: its real node content when known,
    // otherwise the allocated slot (or the fixed collapsed width).
    function fileBoxExtent(f, isCollapsed) {
        const sx = fileStartX.get(f) || 0;
        if (isCollapsed) return { minX: sx, maxX: sx + COLLAPSED_WIDTH };
        const content = fileContentX.get(f);
        if (content && content.minX !== Infinity) return content;
        const slotIdx = fileToSlot.get(f);
        const sw = (slotIdx !== undefined) ? slotWidths[slotIdx] : (fileColumnWidths.get(f) || 0);
        return { minX: sx, maxX: sx + sw };
    }

    // Draw the file boxes first: each one hugs its own node content plus
    // BOX_PADDING. The folder boxes below then wrap the union of those file
    // boxes, so file boxes never spill outside their folder and the folder does
    // not reserve dead space around them.
    fileOrder.forEach((f) => {
        const meta = fileMetaByKey.get(f);
        if (!meta) return;
        const yRange = fileY.get(f);
        if (yRange.minY === Infinity) return;

        // Hide file boxes completely if parent folder is collapsed
        if (meta.folder && collapsedFolders.has(meta.folder)) return;

        const isCollapsed = collapsedFiles.has(f);
        const extent = fileBoxExtent(f, isCollapsed);
        const minX = extent.minX;
        const maxX = extent.maxX;
        const label = meta.file ? meta.file : f;

        fileBoxData.push({
            file: f, label,
            x: minX - BOX_PADDING,
            y: yRange.minY - FILE_BOX_PAD_TOP,
            width: maxX - minX + 2 * BOX_PADDING,
            height: yRange.maxY - yRange.minY + FILE_BOX_PAD_TOP + FILE_BOX_PAD_BOTTOM,
            color: getFileColor(f),
            collapsed: isCollapsed
        });
    });

    orderedFolders.forEach((folder) => {
        if (!folder) return;
        const files = orderedFilesByFolder.get(folder) || [];
        if (files.length === 0) return;
        const yRange = folderY.get(folder);
        if (yRange.minY === Infinity) return;

        const isCollapsed = collapsedFolders.has(folder);

        // Folder box hugs the union of its file boxes (which are already
        // content + BOX_PADDING). Keeping the folder at the same extent as its
        // outermost file boxes avoids both dead space and folder boxes of
        // neighbouring columns overlapping each other.
        let folderMinX = Infinity, folderMaxX = -Infinity;
        files.forEach(f => {
            const fiBox = fileY.get(f);
            if (!fiBox || fiBox.minY === Infinity) return;
            const extent = fileBoxExtent(f, isCollapsed || collapsedFiles.has(f));
            folderMinX = Math.min(folderMinX, extent.minX);
            folderMaxX = Math.max(folderMaxX, extent.maxX);
        });
        if (folderMinX === Infinity) return;

        folderBoxData.push({
            folder,
            x: folderMinX - BOX_PADDING,
            y: yRange.minY - FOLDER_BOX_PAD_TOP,
            width: folderMaxX - folderMinX + 2 * BOX_PADDING,
            height: yRange.maxY - yRange.minY + FOLDER_BOX_PAD_TOP + FOLDER_BOX_PAD_BOTTOM,
            color: getFolderColor(folder),
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
    // Edges are hidden by default and only the highlighted edges of a hovered or
    // clicked node reappear. Toggling "Edges" on shows every edge as before.
    const showEdges = document.getElementById("toggle-edges");
    svg.classed("edges-off", !!(showEdges && !showEdges.checked));
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
        .attr("stroke-dasharray", "8,4").attr("rx", FOLDER_BOX_CORNER_RADIUS);

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
        .attr("stroke-dasharray", "5,5").attr("rx", FILE_BOX_CORNER_RADIUS);

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

    // --- Degree "hats": small bars on top (incoming) and bottom (outgoing) of a
    // node in the base view. Their width grows with the number of connected
    // edges (capped just under the node width) and they are only shown while the
    // actual edges are hidden.
    const showDegreeHats = (options && options.showDegreeHats !== undefined)
        ? !!options.showDegreeHats
        : !focusNodeId;
    // HAT_HEIGHT / HAT_MIN_WIDTH / HAT_MAX_WIDTH_RATIO live in constants.js.

    // Count distinct real neighbours, resolving the dummy nodes that multi-layer
    // edges insert (dummy ids look like "dummy|source|target|layer").
    function countRealNeighbors(neighborMap, id, realIndexInDummyId) {
        const list = neighborMap.get(id) || [];
        const unique = new Set();
        for (const other of list) {
            const s = String(other);
            if (s.startsWith("dummy|")) {
                const parts = s.split("|");
                const real = parts[realIndexInDummyId];
                if (real) unique.add(real);
            } else {
                unique.add(s);
            }
        }
        return unique.size;
    }

    let maxInDegree = 1;
    let maxOutDegree = 1;
    const inDegreeById = new Map();
    const outDegreeById = new Map();

    if (showDegreeHats) {
        nodeData.forEach(d => {
            if (d.isDummy) return;
            const outDeg = countRealNeighbors(edges, d.id, 2);
            const inDeg = countRealNeighbors(reverseEdgesMap, d.id, 1);
            outDegreeById.set(d.id, outDeg);
            inDegreeById.set(d.id, inDeg);
            if (outDeg > maxOutDegree) maxOutDegree = outDeg;
            if (inDeg > maxInDegree) maxInDegree = inDeg;
        });
    }

    function computeHatWidth(count, maxCount, nodeWidth) {
        if (!count || count <= 0) return 0;
        if (maxCount <= 1) return HAT_MIN_WIDTH;
        const maxWidth = Math.max(HAT_MIN_WIDTH, nodeWidth * HAT_MAX_WIDTH_RATIO);
        const t = Math.sqrt((count - 1) / (maxCount - 1)); // 0 for a single edge
        return HAT_MIN_WIDTH + (maxWidth - HAT_MIN_WIDTH) * t;
    }

    container.node().updateEdgeRouting = function() {
        const isOrthogonal = document.getElementById("toggle-orthogonal")?.checked;
        edgesGroup.selectAll("path.graph-edge").attr("d", (d) => buildPathLine(d, nodeDims, isOrthogonal));
        if (typeof container.node().updateViewportCulling === "function") {
            container.node().updateViewportCulling(true);
        }
    };

    // Re-apply stroke widths to the currently rendered edges. Called when the
    // "Thick Edges" toggle changes. Edges created later (viewport culling) pick
    // up the current setting automatically when they are (re)entered.
    container.node().updateEdgeThickness = function() {
        edgesGroup.selectAll("path.graph-edge")
            .attr("stroke-width", (d) => computeEdgeStrokeWidth(d));
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

    // Re-run the layout/render pipeline with the exact current graph data and
    // collapse/zoom state. Used when a setting that changes geometry (e.g. the
    // orthogonal / edges toggles, which together decide how much vertical space
    // the layout must reserve) changes. Unlike expand/collapse this does not
    // change which nodes are visible or reset the viewport.
    container.node().relayout = function() {
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
        // Role text colours are inlined only for focused sub-graphs, where the
        // role can never change. The main view gets its role colours from the
        // CSS classes so closing the side panel cleanly restores neutral text.
        if (focusNodeId) {
            const role = getNodeRole(d);
            if (role === "caller") return "#7c2d12";
            if (role === "callee") return "#134e4a";
            if (role === "both") return "#312e81";
        }
        return "#1f2937";
    };

    // In a focused sub-graph (the side panel's Callees/Callers/Combined views)
    // every node is either above the focus node (= a caller) or below it
    // (= a callee). The depth ordering built by buildCombinedGraph()/flipGraph()
    // guarantees this, so the role can be read straight from the depth.
    //
    // The main view has no focus node of its own, but while a side-panel tab is
    // open it mirrors that tab's roles: this is what keeps the same node the
    // same colour on the left and on the right.
    const focusNodeData = focusNodeId ? nodeData.find(d => d.id === focusNodeId) : null;
    const focusDepth = focusNodeData ? focusNodeData.depth : null;

    const staticRoleAnchorId = (!focusNodeId && state.activeTabNodeId) ? state.activeTabNodeId : null;
    if (staticRoleAnchorId) {
        if (state.roleAnchorId !== staticRoleAnchorId || !state.roleMap) {
            state.roleAnchorId = staticRoleAnchorId;
            state.roleMap = (typeof window.getFullRoleMap === "function")
                ? window.getFullRoleMap(staticRoleAnchorId)
                : computeRoleMapFromEdges(staticRoleAnchorId, edges, buildReverseEdges(edges));
        }
    } else if (state.roleMap || state.roleAnchorId) {
        state.roleAnchorId = null;
        state.roleMap = null;
    }

    function getNodeRole(d) {
        if (d.isDummy) return null;
        if (focusNodeId) {
            if (focusDepth === null || d.id === focusNodeId) return null;
            if (d.depth < focusDepth) return "caller";
            if (d.depth > focusDepth) return "callee";
            return null;
        }
        return (state.roleMap && state.roleMap.get(d.id)) || null;
    }

    const getNodeClass = (d) => {
        const mt = getNodeMatchType(d);
        let cls = "node-g";
        if (mt) {
            cls += ` search-match search-match-${mt}`;
            if (d.id === activeMatchId) cls += " search-match-active";
        }
        if (isTabNode(d)) cls += " node-active-tab";
        const role = getNodeRole(d);
        if (role) cls += ` node-role-${role}`;
        return cls;
    };

    function appendNodeText(selection) {
        const textNodes = selection.append("text")
            .attr("class", "node-text")
            .attr("x", d => d.width / 2).attr("y", d => d.height / 2 - (d.lines.length - 1) * (NODE_TEXT_LINE_SPACING / 2))
            .attr("text-anchor", "middle").attr("font-size", NODE_FONT_SIZE)
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
            .attr("x", d => d.width / 2).attr("dy", (_, i) => (i === 0 ? 0 : NODE_TEXT_LINE_SPACING))
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

    // --- Floating "Full Graph" Navigation Button (always visible, bottom-right) ---
    const backBtn = container.append("button")
        .attr("type", "button")
        .attr("class", "btn-back-to-graph")
        .attr("title", "View the full graph")
        .attr("aria-label", "View the full graph");

    backBtn.append("span")
        .attr("class", "back-graph-arrow")
        .text("⌖");

    backBtn.append("span")
        .attr("class", "back-graph-text")
        .text("Full Graph");

    // The button is permanently visible in the bottom-right corner, so there is
    // no longer any visibility state to update on zoom or resize.
    function updateNavButton() {}

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
    // Gather every edge that touches the current highlight (hovered/clicked
    // node's neighbourhood). Used when the global "Edges" toggle is off so we
    // only keep the few revealed edges in the DOM instead of thousands of
    // invisible <path> elements.
    function collectHighlightEdges(activeSet, primaryId) {
        if (!activeSet || activeSet.size === 0) return [];
        const seen = new Set();
        const out = [];
        const addEdgesFor = (id) => {
            if (!id) return;
            const list = edgesByNodeId.get(id);
            if (!list) return;
            for (let i = 0; i < list.length; i++) {
                const e = list[i];
                if (!seen.has(e)) {
                    seen.add(e);
                    out.push(e);
                }
            }
        };
        if (primaryId) addEdgesFor(primaryId);
        for (const id of activeSet) addEdgesFor(id);
        return out;
    }

    function updateViewportCulling(force = false) {
        const transform = state.currentZoomTransform || d3.zoomIdentity;
        const k = transform.k || 1;
        const vpW = (containerNode && containerNode.clientWidth > 0) ? containerNode.clientWidth : fallbackWidth;
        const vpH = (containerNode && containerNode.clientHeight > 0) ? containerNode.clientHeight : viewportHeight;

        const highlight = (state.getActiveHighlight && state.getActiveHighlight()) || {};
        const curActiveSet = highlight.activeSet;
        const curPrimaryId = highlight.primaryId;
        const curRoles = highlight.roles;

        const edgesGloballyVisible = !!(document.getElementById("toggle-edges") && document.getElementById("toggle-edges").checked);
        // "Small graph" fast path: skip the spatial query and draw everything.
        // Base the decision on the *total* drawable count (nodes + edges), not
        // just nodes — otherwise the fully-collapsed overview (0 visible nodes,
        // but thousands of edges) took this path and materialised every edge.
        const isSmallGraph = (visibleNodeData.length + linkData.length) <= 800;
        const showText = visibleNodeData.length <= 150 || (k >= 0.16);

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
                if (edgesGloballyVisible) {
                    const rawCulledEdges = spatialEdgeIndex.query(viewMinX, viewMinY, viewMaxX, viewMaxY);
                    culledEdges = isOrthogonal ? rawCulledEdges : rawCulledEdges.filter(e => !e.isFromDummy);
                } else {
                    culledEdges = [];
                }
            }
        }

        // When the "Edges" toggle is off, the only edges worth having in the DOM
        // are the ones belonging to the active highlight. Everything else is
        // invisible, so keeping it around just wastes memory and style-recalc
        // time on every hover.
        if (!edgesGloballyVisible) {
            culledEdges = collectHighlightEdges(curActiveSet, curPrimaryId);
        }

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
            .attr("rx", NODE_CORNER_RADIUS)
            .attr("fill", d => getNodeRectFill(d))
            .attr("stroke", d => getNodeRectStroke(d))
            .attr("stroke-width", d => getNodeRectStrokeWidth(d))
            .attr("filter", d => getNodeFilter(d));

        // Degree hats: incoming bar on top, outgoing bar on the bottom.
        if (showDegreeHats) {
            enteredNodes.each(function(d) {
                const nodeG = d3.select(this);
                const inW = computeHatWidth(inDegreeById.get(d.id) || 0, maxInDegree, d.width);
                const outW = computeHatWidth(outDegreeById.get(d.id) || 0, maxOutDegree, d.width);

                if (inW > 0) {
                    nodeG.append("rect")
                        .attr("class", "degree-hat degree-hat-in")
                        .attr("x", d.width / 2 - inW / 2)
                        .attr("y", -HAT_HEIGHT)
                        .attr("width", inW)
                        .attr("height", HAT_HEIGHT)
                        .attr("rx", HAT_CORNER_RADIUS);
                }
                if (outW > 0) {
                    nodeG.append("rect")
                        .attr("class", "degree-hat degree-hat-out")
                        .attr("x", d.width / 2 - outW / 2)
                        .attr("y", d.height)
                        .attr("width", outW)
                        .attr("height", HAT_HEIGHT)
                        .attr("rx", HAT_CORNER_RADIUS);
                }
            });
        }

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
                    const role = curRoles && curRoles.get(d.id);
                    if (role) this.classList.add(`node-highlight-${role}`);
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
            .attr("fill", "none").attr("stroke", "#94a3b8")
            .attr("stroke-width", d => computeEdgeStrokeWidth(d))
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
    state.requestCulling = scheduleCulling;

    if (window.ResizeObserver && containerNode) {
        if (containerNode._navResizeObserver) {
            containerNode._navResizeObserver.disconnect();
        }
        const ro = new ResizeObserver(() => {
            updateNavButton();
            // Keep the pan boundary in sync with the current viewport size.
            zoom.extent([[0, 0], [containerNode.clientWidth, containerNode.clientHeight]]);
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
        // Keep the user from panning the graph completely out of view: the
        // viewport may never move past the graph's bounding box.
        .translateExtent([[gMinX, gMinY], [gMaxX, gMaxY]])
        .extent([[0, 0], [viewportWidth, viewportHeight]])
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
    // Map nodeId -> "caller" | "callee" | "both" for the current highlight.
    // Only used by the main view: focused side-panel graphs know every node's
    // role statically from its depth (see getNodeRole in renderGraph).
    let currentHighlightRoles = null;

    // Full transitive closure of a node within the rendered graph: every node
    // that can (transitively) call it, plus every node it can (transitively)
    // call. Used for click selection, so all levels light up, not just one.
    function fullClosure(nodeId) {
        return getAllConnected(nodeId, edgesMap, reverseEdgesMap);
    }

    // Classify the highlighted neighbourhood of `primaryId` into callers
    // (reachable backwards) and callees (reachable forwards). The traversal is
    // bounded to the highlighted set, so the cheap immediate-neighbour hover
    // does not walk the whole graph. Dummy routing nodes are still traversed.
    function computeHighlightRoles(activeSet, primaryId) {
        const roles = new Map();
        if (!activeSet || !primaryId || !activeSet.size) return roles;

        const highlighted = new Set(activeSet);
        highlighted.add(primaryId);
        const bitById = new Map();

        const walk = (nextMap, bit) => {
            const seen = new Set([primaryId]);
            const stack = [primaryId];
            while (stack.length) {
                const current = stack.pop();
                const nexts = nextMap.get(current);
                if (!nexts) continue;
                for (const next of nexts) {
                    if (seen.has(next)) continue;
                    seen.add(next);
                    if (String(next).startsWith("dummy|")) {
                        stack.push(next);
                        continue;
                    }
                    if (!highlighted.has(next)) continue;
                    stack.push(next);
                    bitById.set(next, (bitById.get(next) || 0) | bit);
                }
            }
        };

        walk(edgesMap, 1);        // forward = callees
        walk(reverseEdgesMap, 2); // backward = callers

        for (const [id, bits] of bitById) {
            roles.set(id, bits === 3 ? "both" : (bits === 1 ? "callee" : "caller"));
        }
        return roles;
    }

    const isDimEnabled = () => window.dimHighlightEnabled !== false;

    // True when the pointer moved from one interactive graph element to another
    // (node <-> node or node <-> edge). In that case the upcoming mouseover will
    // immediately replace the highlight, so we must NOT tear the highlight down
    // in between: doing so toggles the global `has-highlight` dimming class twice
    // per move, forcing thousands of opacity transitions and style recalcs.
    function movedWithinGraph(relatedTarget) {
        return !!(relatedTarget && relatedTarget.closest && relatedTarget.closest(".node-g, .graph-edge"));
    }

    // A hovered node reveals the edges to/from its immediate neighbours. If a
    // neighbour lives in a collapsed folder or file, that edge would otherwise
    // end on a closed box instead of on a node. Open exactly those containers
    // (the ones the highlighted edges lead to) so the edge target is visible.
    // Returns true when the collapse state changed and a re-render is needed.
    function expandBoxesForHighlight(activeSet, primaryId) {
        if (!activeSet || !state || !state.currentGraphData || !state.currentGraphData.nodes) return false;
        const nodes = state.currentGraphData.nodes;
        let changed = false;

        for (const nodeId of activeSet) {
            if (!nodeId || nodeId === primaryId || String(nodeId).startsWith("dummy|")) continue;
            const rawLabel = nodes.get(nodeId);
            if (!rawLabel) continue;

            const info = parseNodeLabel(rawLabel);
            if (info.folder && state.collapsedFolders.has(info.folder)) {
                state.collapsedFolders.delete(info.folder);
                changed = true;
            }
            const fileKey = makeFileKey(info.folder, info.file);
            if (fileKey && state.collapsedFiles.has(fileKey)) {
                state.collapsedFiles.delete(fileKey);
                changed = true;
            }
        }

        return changed;
    }

    // Re-render after a hover-driven expansion while keeping the hovered node
    // highlighted. The DOM is replaced, so the regular mouseover/mouseout pair
    // will not fire for the old element; a one-shot mousemove guard clears the
    // restored highlight as soon as the pointer leaves the new element.
    function renderForHoverExpansion(primaryId, activeSet) {
        // Remember where the hovered node currently sits on screen. Opening
        // boxes re-flows the layout, which would otherwise move the node (and
        // the node under the pointer) far away. Compensate the camera after the
        // re-render so the node stays pinned to exactly the same screen spot.
        const oldPos = state.nodePositions && state.nodePositions.get(primaryId);
        const oldTransform = state.currentZoomTransform || d3.zoomIdentity;
        const screenX = oldPos ? oldPos.x * oldTransform.k + oldTransform.x : null;
        const screenY = oldPos ? oldPos.y * oldTransform.k + oldTransform.y : null;

        state.pendingHoverNodeId = primaryId;
        state.pendingHoverActiveSet = activeSet;
        // Do not re-run search-focus camera moves from the options that were
        // used for the previous render; the hover anchor is applied instead.
        const { focusSearchNodeId, animateToNode, ...renderOptions } = options || {};
        renderGraph(
            state.currentGraphData.levels,
            state.currentGraphData.depthById,
            state.currentGraphData.nodes,
            state.currentGraphData.edges,
            container,
            state,
            { ...renderOptions, collapseAllOnInit: false }
        );

        const newPos = state.nodePositions && state.nodePositions.get(primaryId);
        if (screenX === null || !newPos || !state.currentZoomBehavior) return;

        const k = (state.currentZoomTransform || d3.zoomIdentity).k;
        const anchoredTransform = d3.zoomIdentity
            .translate(screenX - newPos.x * k, screenY - newPos.y * k)
            .scale(k);

        const svg = container.select("svg");
        if (svg.empty()) return;
        svg.call(state.currentZoomBehavior.transform, anchoredTransform);
        // The camera moved in world space, so re-run culling for the new view.
        if (typeof container.node().updateViewportCulling === "function") {
            container.node().updateViewportCulling(true);
        }
    }

    function installHoverClearGuard() {
        const svgNode = svgEl.node();
        if (!svgNode) return;
        const guard = function(event) {
            svgNode.removeEventListener("mousemove", guard, true);
            const target = event.target;
            const insideInteractive = target && target.closest && (target.closest(".node-g") || target.closest(".graph-edge"));
            if (!insideInteractive) {
                updateHighlightState(null, null);
                if (options && typeof options.onNodeMouseOut === "function") {
                    options.onNodeMouseOut();
                }
            }
        };
        svgNode.addEventListener("mousemove", guard, true);
    }

    function updateHighlightState(activeSet, primaryId) {
        // 1. Clear the previous highlight directly in the DOM. Querying the
        //    visible selection avoids retaining references to elements that the
        //    viewport-culling engine has since removed (a detached-DOM leak), and
        //    is bounded by what is actually rendered at this moment.
        if (currentActiveSet) {
            nodesGroup.selectAll(".node-primary-highlight").classed("node-primary-highlight", false);
            nodesGroup.selectAll(".node-connected-highlight").classed("node-connected-highlight", false);
            nodesGroup.selectAll(".node-highlight-caller").classed("node-highlight-caller", false);
            nodesGroup.selectAll(".node-highlight-callee").classed("node-highlight-callee", false);
            nodesGroup.selectAll(".node-highlight-both").classed("node-highlight-both", false);
            edgesGroup.selectAll(".edge-primary-highlight").classed("edge-primary-highlight", false);
            edgesGroup.selectAll(".edge-connected-highlight").classed("edge-connected-highlight", false);
        }

        currentActiveSet = activeSet;
        currentPrimaryId = primaryId;
        // Focused side-panel graphs use the static depth-based role classes, and
        // the main view uses the static roles of the active side-panel tab.
        // In both cases the caller/callee hue stays anchored to the focused
        // node instead of flipping to whatever node happens to be hovered.
        // Only a main view with no open side tab falls back to classifying the
        // hovered/selected node's neighbourhood dynamically.
        const hasStaticRoles = !!(state && (state.focusNodeId || state.roleMap));
        currentHighlightRoles = (!hasStaticRoles && activeSet && primaryId)
            ? computeHighlightRoles(activeSet, primaryId)
            : null;

        // If no activeSet, remove highlight classes and exit
        if (!activeSet) {
            svgEl.classed("has-highlight", false);
            scheduleHighlightCulling();
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
                    const role = currentHighlightRoles && currentHighlightRoles.get(nodeId);
                    if (role) nodeObj.el.classList.add(`node-highlight-${role}`);
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

        scheduleHighlightCulling();
    }

    // When the global "Edges" toggle is off, the rendered edge set depends on
    // the current highlight, so a highlight change has to re-run the culling pass
    // to add/remove the revealed edges. Throttled to one pass per frame.
    function scheduleHighlightCulling() {
        const edgesGloballyVisible = !!(document.getElementById("toggle-edges") && document.getElementById("toggle-edges").checked);
        if (!edgesGloballyVisible && typeof state.requestCulling === "function") {
            state.requestCulling();
        }
    }

    state.getActiveHighlight = () => ({
        activeSet: currentActiveSet,
        primaryId: currentPrimaryId,
        roles: currentHighlightRoles
    });
    state.updateHighlightState = updateHighlightState;

    // Restore active clicked node or search state
    if (activeClickedNodeId && nodeElementsById.has(activeClickedNodeId)) {
        updateHighlightState(fullClosure(activeClickedNodeId), activeClickedNodeId);
    } else {
        activeClickedNodeId = null;
        if (state) state.activeClickedNodeId = null;

        // A hover-driven expansion re-rendered the graph. Node/edge DOM is
        // created later by the culling pass, but setting the highlight now
        // makes that pass give the hovered node and its edges their classes.
        const pendingId = state && state.pendingHoverNodeId;
        const pendingSet = state && state.pendingHoverActiveSet;
        if (state) {
            state.pendingHoverNodeId = null;
            state.pendingHoverActiveSet = null;
        }

        if (pendingId && pendingSet) {
            updateHighlightState(pendingSet, pendingId);
            installHoverClearGuard();
        } else {
            updateHighlightState(null, null);
        }
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

            // Open the containers the highlighted edges lead into before
            // drawing the highlight, so no revealed edge ends at a closed box.
            if (expandBoxesForHighlight(immediateNeighbors, d.id)) {
                renderForHoverExpansion(d.id, immediateNeighbors);
                if (options && typeof options.onNodeHover === "function") {
                    options.onNodeHover(d.id, immediateNeighbors);
                }
                return;
            }

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
                const allConnected = fullClosure(d.id);
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

            // Same as node hover: make sure the highlighted edges can actually
            // land on nodes instead of closed folder/file boxes.
            if (expandBoxesForHighlight(activeSet, origin)) {
                renderForHoverExpansion(origin, activeSet);
                if (options && typeof options.onNodeHover === "function") {
                    options.onNodeHover(origin, activeSet);
                }
                return;
            }

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
                updateHighlightState(fullClosure(activeClickedNodeId), activeClickedNodeId);
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
            const allConnected = passedActiveSet || fullClosure(nodeId);
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

            // Keep the main view's caller/callee colours in sync with the
            // active side-panel tab. Roles are anchored to that tab's node, so
            // the same node has the same colour on both sides of the split.
            const roleMap = nodeId
                ? ((typeof window.getFullRoleMap === "function")
                    ? window.getFullRoleMap(nodeId)
                    : computeRoleMapFromEdges(nodeId, edgesMap, reverseEdgesMap))
                : null;
            state.roleAnchorId = nodeId || null;
            state.roleMap = roleMap;
            nodesGroup.selectAll("g.node-g").each(function(d) {
                const role = (d && !d.isDummy && roleMap && roleMap.get(d.id)) || null;
                this.classList.toggle("node-role-caller", role === "caller");
                this.classList.toggle("node-role-callee", role === "callee");
                this.classList.toggle("node-role-both", role === "both");
            });

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
                updateHighlightState(fullClosure(activeClickedNodeId), activeClickedNodeId);
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