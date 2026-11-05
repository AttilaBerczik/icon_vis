const ROOT_FILE = "icon.f90";
const ROOT_FUNCTION = "__MAIN__";
const DATA_BASE = "vis/";

// Keeps the pristine graph and the live main-view state so the graph can be
// rebuilt after a folder/file is hidden or the "Show Hidden" option changes.
let mainViewContext = null;
let parsedGraph = null;
let graphMeta = null;
let dataflowClient = null;

let showExternalStubs = false;
let layoutWorker = null;
let layoutRequestId = 0;

// Interaction state for the parameter card / data trace.
let lastHoverNodeId = null;
let lastSelectedNodeId = null;
let paramPillNodeId = null;
let paramCardNodeId = null;
let paramCardPinned = false;
let paramCardData = null;
// The graph pane that owns the node shown in the parameter card. When the card
// is opened from a side-panel tab this points at that tab's graph, so the card
// follows the graph the user actually right-clicked instead of the main view.
let paramCardSourceContainer = null;
let currentTrace = null;
let currentTraceView = null;
let currentTraceMode = "full";
let currentParamEntity = null;
let currentTraceGroupId = null;
let currentTraceLabel = null;
let roleFilterMask = 15;
let includePasses = true;
let searchMode = "functions";
// Previous trace restored when an on-demand struct highlight is cleared.
let structHighlightRestore = null;
let currentStructTouch = null;
let currentStructLabel = null;

// Used by panel.js to avoid adding a call-graph selection highlight on top of
// an active data trace.
window.isDataTraceActive = () => !!currentTrace;

// The parameter card and the data lifecycle are read-only "inspection" views:
// the focused node already stands out by colour, so dimming every other node
// would only make the graph harder to read. render.js consults this to decide
// whether the call-graph highlight should fade unrelated nodes.
window.isParameterViewActive = () => {
    if (currentTrace) return true;
    if (paramCardNodeId !== null) return true;
    const manager = window.detailPanelManager;
    if (manager && Array.isArray(manager.tabs)) {
        const active = manager.tabs.find(t => t.id === manager.activeTabId);
        if (active && (active.type === "lifecycle" || active.type === "struct")) return true;
    }
    return false;
};

let dataSearchResults = [];
let dataSearchSelection = -1;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const SOURCE_DOT = new URLSearchParams(location.search).get("source") === "dot";

if (SOURCE_DOT) {
    loadDotSource();
} else {
    loadDataflowSource().catch(() => loadDotSource());
}

function loadDataflowSource() {
    return Promise.all([
        fetch(DATA_BASE + "graph.json", { cache: "force-cache" }).then((r) => {
            if (!r.ok) throw new Error("Unable to load vis/graph.json");
            return r.json();
        }),
        fetch(DATA_BASE + "layout.json", { cache: "force-cache" })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
    ]).then(([payload, layoutJson]) => {
        parsedGraph = parseGraphJson(payload);
        graphMeta = parsedGraph.meta;
        setupDataflow(payload);
        initViewer(normalizeLayout(layoutJson));
    });
}

function loadDotSource() {
    fetch("callgraph_folders.dot")
        .then((response) => {
            if (!response.ok) throw new Error("Unable to load callgraph_folders.dot");
            return response.text();
        })
        .then((dotText) => {
            parsedGraph = parseDot(dotText);
            graphMeta = parsedGraph.meta;
            initViewer(null);
        })
        .catch((error) => renderError(error.message));
}

function setupDataflow(payload) {
    dataflowClient = new DataflowClient(DATA_BASE);
    dataflowClient.init().then(() => {
        // Warm the parameter shards while the browser is idle.
        const shards = payload.fnShards || [];
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
        idle(() => dataflowClient.prefetchParams(shards));
    });
    window.dataflowClient = dataflowClient;
}

function normalizeLayout(json) {
    if (!json || !json.folderOrder || !json.nodeOrderByFileDepth) return null;
    const fileOrderByFolder = new Map();
    for (const [folder, files] of Object.entries(json.fileOrderByFolder || {})) {
        fileOrderByFolder.set(folder, files);
    }
    const nodeOrderByFileDepth = new Map();
    for (const [file, depths] of Object.entries(json.nodeOrderByFileDepth || {})) {
        const depthMap = new Map();
        for (const [depth, ids] of Object.entries(depths)) {
            depthMap.set(Number(depth), ids);
        }
        nodeOrderByFileDepth.set(file, depthMap);
    }
    const fileMetaByKey = new Map();
    for (const [key, meta] of Object.entries(json.fileMetaByKey || {})) {
        fileMetaByKey.set(key, meta);
    }
    return {
        folderOrder: json.folderOrder,
        fileOrderByFolder,
        nodeOrderByFileDepth,
        fileMetaByKey
    };
}

function initViewer(precomputedLayout) {
    window.graphMetaForStruct = graphMeta;
    window.parsedGraphForStruct = parsedGraph;
    const view = buildViewData(parsedGraph, showExternalStubs);
    const originalNodes = view.nodes;
    const originalEdges = view.edges;

    // Keep pristine copies of nodes & edges for dynamic sub-graph views.
    const pristineNodes = cloneNodes(originalNodes);
    const pristineEdges = cloneEdges(originalEdges);

    installGlobalGraphHelpers(pristineEdges);

    if (window.DetailPanelManager) {
        window.detailPanelManager = new DetailPanelManager();
        window.detailPanelManager.init(pristineNodes, pristineEdges);
    }

    renderMainMode(pristineNodes, pristineEdges, view.rootId, precomputedLayout);
}

function installGlobalGraphHelpers(pristineEdges) {
    const fullEdgesMap = new Map();
    const fullReverseEdgesMap = new Map();
    for (const [from, targets] of pristineEdges) {
        if (!fullEdgesMap.has(from)) fullEdgesMap.set(from, []);
        for (const to of targets) {
            fullEdgesMap.get(from).push(to);
            if (!fullReverseEdgesMap.has(to)) fullReverseEdgesMap.set(to, []);
            fullReverseEdgesMap.get(to).push(from);
        }
    }
    window.getFullImmediateNeighbors = function(nodeId) {
        return getImmediateNeighbors(nodeId, fullEdgesMap, fullReverseEdgesMap);
    };
    window.getFullAllConnected = function(nodeId) {
        return getAllConnected(nodeId, fullEdgesMap, fullReverseEdgesMap);
    };
    window.getFullRoleMap = function(nodeId) {
        return computeRoleMapFromEdges(nodeId, fullEdgesMap, fullReverseEdgesMap);
    };
}

/**
 * Turn the static data-flow graph into the Map shape used by layout/render.
 * External stubs are hidden by default; when shown they are folded into one
 * node per library (mpi, kokkos, ...), as specified by the viewer plan.
 */
function buildViewData(parsed, includeExternal) {
    const meta = parsed.meta || {};
    const nodes = new Map();
    const edges = new Map();
    const edgeWeights = new Map();
    const records = new Map();

    const externalLibForNode = new Map();
    const libraryCounts = new Map();
    const libraryNodeIds = new Map();

    if (includeExternal && meta.nodeRecords) {
        for (const rec of meta.nodeRecords) {
            if (!rec || !rec.external) continue;
            const lib = rec.library || "external";
            externalLibForNode.set(rec.id, lib);
            libraryCounts.set(lib, (libraryCounts.get(lib) || 0) + 1);
            if (!libraryNodeIds.has(lib)) {
                const id = `extlib:${lib}`;
                libraryNodeIds.set(lib, id);
                nodes.set(id, `external\\n${lib}\\n${libraryCounts.get(lib)} calls`);
                records.set(id, {
                    id,
                    functionId: null,
                    name: lib,
                    folder: "external",
                    file: lib,
                    kind: "external",
                    exec: "external",
                    external: true,
                    library: lib,
                    paramCount: 0,
                    readCount: 0,
                    writeCount: 0,
                    line: 0,
                    shard: null
                });
            } else {
                const id = libraryNodeIds.get(lib);
                nodes.set(id, `external\\n${lib}\\n${libraryCounts.get(lib)} calls`);
            }
        }
    }

    for (const [id, label] of parsed.nodes) {
        const rec = meta.nodeRecords ? meta.nodeRecords[id] : null;
        if (rec && rec.external) {
            if (!includeExternal) continue;
            // External nodes are represented by one synthetic node per library.
            if (!edges.has(libraryNodeIds.get(rec.library || "external"))) {
                // nothing; edges are built below
            }
            continue;
        }
        nodes.set(id, label);
        if (rec) records.set(id, rec);
    }

    const mapEndpoint = (id) => {
        const rec = meta.nodeRecords ? meta.nodeRecords[id] : null;
        if (rec && rec.external) {
            if (!includeExternal) return null;
            return libraryNodeIds.get(rec.library || "external");
        }
        return nodes.has(id) ? id : null;
    };

    for (const [from, targets] of parsed.edges) {
        const mappedFrom = mapEndpoint(from);
        if (mappedFrom === null) continue;
        for (const to of targets) {
            const mappedTo = mapEndpoint(to);
            if (mappedTo === null || mappedTo === mappedFrom) continue;
            if (libraryNodeIds.has(mappedTo) && mappedFrom === mappedTo) continue;
            if (!edges.has(mappedFrom)) edges.set(mappedFrom, new Set());
            edges.get(mappedFrom).add(mappedTo);
            const w = parsed.edgeWeights.get(`${from}|${to}`) || 1;
            const key = `${mappedFrom}|${mappedTo}`;
            edgeWeights.set(key, (edgeWeights.get(key) || 0) + w);
        }
    }

    let maxWeight = 1;
    for (const w of edgeWeights.values()) if (w > maxWeight) maxWeight = w;
    window.globalEdgeWeightMap = edgeWeights;
    window.globalMaxEdgeWeight = maxWeight;

    let rootId = meta.root !== undefined ? meta.root : findRootId(parsed.nodes);
    if (rootId !== undefined && !nodes.has(rootId)) rootId = [...nodes.keys()][0];

    return { nodes, edges, edgeWeights, records, rootId };
}

function findRootId(nodes) {
    for (const [id, label] of nodes.entries()) {
        const labelInfo = parseNodeLabel(label);
        const functionName = labelInfo.lines[labelInfo.lines.length - 1];
        if (labelInfo.file === ROOT_FILE && functionName === ROOT_FUNCTION) return id;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

function renderMainMode(pristineNodes, pristineEdges, rootId, precomputedLayout) {
    if (rootId === null || rootId === undefined || !pristineNodes.has(rootId)) {
        renderError("Could not find the program root in graph.json.");
        return;
    }

    const rootLabel = parseNodeLabel(pristineNodes.get(rootId));
    window.mainRootInfo = {
        folder: rootLabel.folder,
        fileKey: makeFileKey(rootLabel.folder, rootLabel.file)
    };

    const nodes = cloneNodes(pristineNodes);
    const edges = cloneEdges(pristineEdges);
    const container = d3.select("#visualization");
    const state = createGraphState();

    const { levels, depthById } = buildLevels(rootId, edges, nodes);
    const options = {
        collapseAllOnInit: true,
        precomputedLayout,
        onNodeHover: (hId, activeSet) => {
            lastHoverNodeId = hId;
            if (window.detailPanelManager && typeof window.detailPanelManager.highlightNodeHover === "function") {
                window.detailPanelManager.highlightNodeHover(hId, activeSet);
            }
        },
        onNodeMouseOut: () => {
            lastHoverNodeId = null;
            if (window.detailPanelManager && typeof window.detailPanelManager.clearNodeHover === "function") {
                window.detailPanelManager.clearNodeHover();
            }
        },
        onNodeClick: (cId, activeSet) => {
            lastSelectedNodeId = cId;
            if (cId) {
                showParamPill(cId);
            } else {
                hideParamPill();
                if (!paramCardPinned) closeParamCard();
            }
            if (window.detailPanelManager && typeof window.detailPanelManager.selectNode === "function") {
                window.detailPanelManager.selectNode(cId, activeSet);
            }
        }
    };

    mainViewContext = { rootId, pristineNodes, pristineEdges, container, state, options };
    state.onTransform = updateOverlayPositions;
    renderGraph(levels, depthById, nodes, edges, container, state, options);

    // Seed any remaining unreached folders/files in nodes to ensure they also have locked-in consistent colors
    for (const [id, rawLabel] of nodes.entries()) {
        const labelInfo = parseNodeLabel(rawLabel);
        if (labelInfo.folder && window.getFolderColor) window.getFolderColor(labelInfo.folder);
        const fileKey = makeFileKey(labelInfo.folder, labelInfo.file);
        if (fileKey && window.getFileColor) window.getFileColor(fileKey);
    }

    setupSearchUI(container.node());
    updateOverlayPositions();
}

// Rebuild the main graph after the hidden folders/files or external-library
// option changed. The layout is computed in a worker when possible, so hiding a
// folder does not freeze the tab for a second.
function rebuildMainView() {
    if (!mainViewContext) return;

    const { rootId, pristineNodes, pristineEdges, container, state, options } = mainViewContext;
    const nodes = cloneNodes(pristineNodes);
    const edges = cloneEdges(pristineEdges);
    const { levels, depthById } = buildLevels(rootId, edges, nodes);

    state.currentGraphData = { levels, depthById, nodes, edges };
    state.cachedLayout = null;
    state.searchState = null;
    state.needsFitToScreen = false;

    const finish = (layout) => {
        state.cachedLayout = layout;
        renderGraph(levels, depthById, nodes, edges, container, state, {
            ...options,
            precomputedLayout: layout,
            collapseAllOnInit: false
        });
        state.onTransform = updateOverlayPositions;
        updateOverlayPositions();
    };

    if (window.Worker) {
        showLayoutBusy(true);
        requestLayoutInWorker(rootId, nodes, edges).then((layout) => {
            showLayoutBusy(false);
            finish(layout);
        }).catch(() => {
            showLayoutBusy(false);
            finish(null);
        });
    } else {
        finish(null);
    }
}

function requestLayoutInWorker(rootId, nodes, edges) {
    if (!window.Worker) return Promise.reject(new Error("no worker"));
    if (!layoutWorker) {
        try {
            layoutWorker = new Worker("layout-worker.js");
        } catch (err) {
            return Promise.reject(err);
        }
    }
    const requestId = ++layoutRequestId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            layoutWorker.removeEventListener("message", onMessage);
            reject(new Error("layout worker timeout"));
        }, 20000);
        const onMessage = (event) => {
            const msg = event.data || {};
            if (msg.requestId !== requestId) return;
            clearTimeout(timer);
            layoutWorker.removeEventListener("message", onMessage);
            if (!msg.ok) {
                reject(new Error(msg.error || "layout failed"));
                return;
            }
            resolve(normalizeLayout({
                folderOrder: msg.result.folderOrder,
                fileOrderByFolder: msg.result.fileOrderByFolder,
                nodeOrderByFileDepth: msg.result.nodeOrderByFileDepth,
                fileMetaByKey: msg.result.fileMetaByKey
            }));
        };
        layoutWorker.addEventListener("message", onMessage);
        layoutWorker.postMessage({
            requestId,
            root: rootId,
            nodes: [...nodes.entries()],
            edges: [...edges.entries()].map(([from, targets]) => [from, [...targets]])
        });
    });
}

function showLayoutBusy(show) {
    const el = document.getElementById("layout-busy");
    if (el) el.style.display = show ? "flex" : "none";
}

function refreshGraphVisibility() {
    rebuildMainView();

    if (window.detailPanelManager && typeof window.detailPanelManager.refreshVisibility === "function") {
        window.detailPanelManager.refreshVisibility();
    }

    const searchInput = document.getElementById("graph-search-input");
    if (searchInput && searchInput.value.trim() && searchMode === "functions") {
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
}
window.refreshGraphVisibility = refreshGraphVisibility;

function rebuildForExternalToggle(showExternal) {
    showExternalStubs = showExternal;
    const view = buildViewData(parsedGraph, showExternal);
    mainViewContext.pristineNodes = cloneNodes(view.nodes);
    mainViewContext.pristineEdges = cloneEdges(view.edges);
    installGlobalGraphHelpers(mainViewContext.pristineEdges);
    if (window.detailPanelManager) {
        window.detailPanelManager.nodes = mainViewContext.pristineNodes;
        window.detailPanelManager.edges = mainViewContext.pristineEdges;
    }
    rebuildMainView();
    if (window.detailPanelManager && typeof window.detailPanelManager.refreshVisibility === "function") {
        window.detailPanelManager.refreshVisibility();
    }
}

// ---------------------------------------------------------------------------
// Toggle Controls
// ---------------------------------------------------------------------------
const toggleEdges = document.getElementById("toggle-edges");
if (toggleEdges) {
    toggleEdges.addEventListener("change", (e) => {
        d3.selectAll("svg").classed("edges-off", !e.target.checked);
        applyContainerAction("updateViewportCulling");
        if (toggleOrthogonal && toggleOrthogonal.checked) applyContainerAction("relayout");
    });
}

const toggleBoxes = document.getElementById("toggle-boxes");
if (toggleBoxes) {
    toggleBoxes.addEventListener("change", (e) => {
        d3.selectAll(".file-bounding-boxes").style("display", e.target.checked ? "block" : "none");
    });
}

const toggleFolderBoxes = document.getElementById("toggle-folder-boxes");
if (toggleFolderBoxes) {
    toggleFolderBoxes.addEventListener("change", (e) => {
        d3.selectAll(".folder-bounding-boxes").style("display", e.target.checked ? "block" : "none");
    });
}

const toggleOrthogonal = document.getElementById("toggle-orthogonal");
if (toggleOrthogonal) {
    toggleOrthogonal.addEventListener("change", () => applyContainerAction("relayout"));
}

const toggleExternal = document.getElementById("toggle-external");
if (toggleExternal) {
    toggleExternal.checked = false;
    toggleExternal.addEventListener("change", (e) => {
        rebuildForExternalToggle(e.target.checked);
    });
}

// --- Hidden Files / Folders ---
window.dimHighlightEnabled = true;
window.edgeThicknessEnabled = true;

const toggleHidden = document.getElementById("toggle-hidden");
if (toggleHidden) {
    toggleHidden.checked = false;
    window.showHiddenFiles = false;
    toggleHidden.addEventListener("change", (e) => {
        window.showHiddenFiles = e.target.checked;
        refreshGraphVisibility();
    });
}

function toggleHiddenFolder(folder) {
    if (!folder) return;
    if (window.hiddenFolders.has(folder)) window.hiddenFolders.delete(folder);
    else window.hiddenFolders.add(folder);
    refreshGraphVisibility();
}

function toggleHiddenFile(fileKey) {
    if (!fileKey) return;
    if (window.hiddenFiles.has(fileKey)) window.hiddenFiles.delete(fileKey);
    else window.hiddenFiles.add(fileKey);
    refreshGraphVisibility();
}

// --- Expand / Collapse Shorthand Controls ---
function applyContainerAction(actionName) {
    const visCombined = d3.select("#visualization").node();
    if (visCombined && typeof visCombined[actionName] === "function") visCombined[actionName]();
    if (window.detailPanelManager && typeof window.detailPanelManager[actionName] === "function") {
        window.detailPanelManager[actionName]();
    }
}

const btnOpenAll = document.getElementById("btn-open-all");
if (btnOpenAll) btnOpenAll.addEventListener("click", () => applyContainerAction("expandAll"));
const btnFoldersOnly = document.getElementById("btn-folders-only");
if (btnFoldersOnly) btnFoldersOnly.addEventListener("click", () => applyContainerAction("expandFoldersOnly"));
const btnCloseAll = document.getElementById("btn-close-all");
if (btnCloseAll) btnCloseAll.addEventListener("click", () => applyContainerAction("collapseAll"));

// --- Context Menu Wiring ---
function closeContextMenu() {
    const ctxMenu = document.getElementById("context-menu");
    if (ctxMenu) ctxMenu.style.display = "none";
}

document.getElementById("ctx-open-tab").addEventListener("click", () => {
    if (contextMenuNodeId !== null && contextMenuNodeId !== undefined && window.detailPanelManager) {
        window.detailPanelManager.openTab(contextMenuNodeId);
    }
    closeContextMenu();
});

const ctxShowParams = document.getElementById("ctx-show-params");
if (ctxShowParams) {
    ctxShowParams.addEventListener("click", () => {
        if (contextMenuNodeId !== null && contextMenuNodeId !== undefined) {
            lastSelectedNodeId = contextMenuNodeId;
            // Keep the card attached to the graph the menu was opened from
            // (main view or a side-panel tab).
            openParamCard(contextMenuNodeId, true,
                contextMenuTarget && contextMenuTarget.sourceContainer);
        }
        closeContextMenu();
    });
}

const ctxShowData = document.getElementById("ctx-show-data");
if (ctxShowData) {
    ctxShowData.addEventListener("click", () => {
        if (contextMenuNodeId !== null && contextMenuNodeId !== undefined) {
            openFunctionData(contextMenuNodeId);
        }
        closeContextMenu();
    });
}

document.getElementById("ctx-hide-file").addEventListener("click", () => {
    closeContextMenu();
    if (contextMenuTarget && contextMenuTarget.fileKey) toggleHiddenFile(contextMenuTarget.fileKey);
});

document.getElementById("ctx-hide-folder").addEventListener("click", () => {
    closeContextMenu();
    if (contextMenuTarget && contextMenuTarget.folder) toggleHiddenFolder(contextMenuTarget.folder);
});

document.addEventListener("click", (e) => {
    const ctxMenu = document.getElementById("context-menu");
    if (ctxMenu && !ctxMenu.contains(e.target)) ctxMenu.style.display = "none";
    const dropdown = document.getElementById("data-search-dropdown");
    if (dropdown && !dropdown.contains(e.target) && e.target.id !== "graph-search-input") {
        dropdown.style.display = "none";
    }
    // An unpinned parameter card closes on a click on the graph background.
    if (!paramCardPinned && paramCardNodeId !== null &&
        e.target.closest && e.target.closest("#visualization svg") &&
        !e.target.closest(".node-g")) {
        closeParamCard();
    }
});

// Dismiss on Escape (info popup -> search dropdown -> card -> trace -> side tab)
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const infoOverlay = document.getElementById("info-overlay");
        if (infoOverlay && infoOverlay.classList.contains("open")) {
            closeInfoPopup();
            return;
        }
        const ctxMenu = document.getElementById("context-menu");
        if (ctxMenu && ctxMenu.style.display !== "none") {
            ctxMenu.style.display = "none";
            return;
        }
        const dropdown = document.getElementById("data-search-dropdown");
        if (dropdown && dropdown.style.display !== "none") {
            dropdown.style.display = "none";
            return;
        }
        if (paramCardNodeId !== null) {
            closeParamCard();
            return;
        }
        if (currentTrace) {
            clearTrace();
            return;
        }
        if (window.detailPanelManager && window.detailPanelManager.activeTabId) {
            window.detailPanelManager.closeTab(window.detailPanelManager.activeTabId);
        }
    } else if (e.key === "p" || e.key === "P") {
        if (e.target && /input|textarea|select/i.test(e.target.tagName || "")) return;
        const nodeId = lastHoverNodeId || lastSelectedNodeId;
        if (nodeId !== null && nodeId !== undefined) {
            if (paramCardNodeId === nodeId) closeParamCard();
            else openParamCard(nodeId, false);
        }
    }
});

// ---------------------------------------------------------------------------
// Search bar: function mode + data mode
// ---------------------------------------------------------------------------

function setupSearchUI(visContainerNode) {
    const searchInput = document.getElementById("graph-search-input");
    const countBadge = document.getElementById("search-match-count");
    const btnPrev = document.getElementById("search-btn-prev");
    const btnNext = document.getElementById("search-btn-next");
    const btnClear = document.getElementById("search-btn-clear");
    const wrapper = searchInput ? searchInput.closest(".search-input-wrapper") : null;
    const dropdown = document.getElementById("data-search-dropdown");

    if (!searchInput) return;

    // The toolbar scrolls horizontally when the inspector is open. Detach the
    // dropdown so it can escape that scroll container and anchor it to the
    // search field in viewport coordinates.
    if (dropdown && dropdown.parentElement !== document.body) {
        document.body.appendChild(dropdown);
    }

    function positionDataDropdown() {
        if (!dropdown || dropdown.style.display === "none") return;
        const anchor = searchInput.closest(".search-input-wrapper");
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const width = Math.min(460, window.innerWidth - 24);
        dropdown.style.position = "fixed";
        dropdown.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
        dropdown.style.top = `${rect.bottom + 4}px`;
    }

    window.addEventListener("resize", positionDataDropdown);
    const headerBar = document.getElementById("left-header-bar");
    if (headerBar) headerBar.addEventListener("scroll", positionDataDropdown);

    let debounceTimer = null;

    function setMode(mode) {
        searchMode = mode === "data" ? "data" : "functions";
        document.querySelectorAll("#search-mode button").forEach((b) => {
            const active = b.dataset.mode === searchMode;
            b.classList.toggle("active", active);
            b.setAttribute("aria-pressed", String(active));
        });
        searchInput.placeholder = searchMode === "data"
            ? "Search data field or parameter (e.g. @rho)"
            : "Search function, file, folder... (Ctrl+F)";
        countBadge.style.display = "none";
        btnPrev.style.display = "none";
        btnNext.style.display = "none";
        if (dropdown) dropdown.style.display = "none";
        if (searchMode === "functions") {
            const q = searchInput.value.trim();
            if (!q && visContainerNode?.clearSearch) visContainerNode.clearSearch();
        }
    }

    function updateUI(res) {
        if (!res || res.count === 0) {
            const rawVal = searchInput.value.trim();
            if (rawVal.length === 0) {
                countBadge.style.display = "none";
                btnPrev.style.display = "none";
                btnNext.style.display = "none";
                btnClear.style.display = "none";
                wrapper?.classList.remove("has-error");
            } else {
                countBadge.style.display = "inline-flex";
                countBadge.className = "search-match-count no-matches";
                countBadge.textContent = "0 matches";
                btnPrev.style.display = "none";
                btnNext.style.display = "none";
                btnClear.style.display = "inline-flex";
                wrapper?.classList.add("has-error");
            }
            return;
        }

        wrapper?.classList.remove("has-error");
        btnClear.style.display = "inline-flex";
        btnPrev.style.display = "inline-flex";
        btnNext.style.display = "inline-flex";
        countBadge.style.display = "inline-flex";
        countBadge.className = "search-match-count has-matches";
        const currentNum = (res.currentIndex >= 0 ? res.currentIndex + 1 : 1);
        const currentMatch = res.matches ? res.matches[res.currentIndex] : null;
        const typeHint = currentMatch ? ` (${currentMatch.type})` : "";
        countBadge.textContent = `${currentNum} / ${res.count}${typeHint}`;
    }

    function doSearch(query) {
        if (!visContainerNode || typeof visContainerNode.search !== "function") return;
        updateUI(visContainerNode.search(query));
    }

    function hideDropdown() {
        if (dropdown) dropdown.style.display = "none";
        dataSearchResults = [];
        dataSearchSelection = -1;
    }

    function dataResultLabel(item) {
        if (item.kind === "struct") return item.name;
        if (item.kind === "field") {
            const member = item.member || item.name;
            const parts = member.split("%");
            return parts.length > 1 ? `${parts[0]} › ${parts.slice(1).join("%")}` : member;
        }
        const type = item.type ? ` : ${item.type}` : "";
        return `${item.name}${type}`;
    }

    function dataResultSub(item) {
        if (item.kind === "field") return item.type ? `member of ${item.type}` : "member";
        if (item.kind === "struct") return "type";
        if (item.kind === "param") return "parameter";
        if (item.kind === "local") return "local";
        return "variable";
    }

    function renderDataDropdown(results) {
        if (!dropdown) return;
        dataSearchResults = results || [];
        dataSearchSelection = dataSearchResults.length ? 0 : -1;
        dropdown.innerHTML = "";
        if (!dataSearchResults.length) {
            const empty = document.createElement("div");
            empty.className = "data-search-empty";
            empty.textContent = "No data names match.";
            dropdown.appendChild(empty);
            dropdown.style.display = "block";
            positionDataDropdown();
            return;
        }
        const groups = {
            struct: "Types",
            field: "Members",
            vars: "Variables",
            other: "Other"
        };
        const order = ["struct", "field", "vars", "other"];
        const category = (item) => {
            if (item.kind === "struct") return "struct";
            if (item.kind === "field") return "field";
            if (item.kind === "param" || item.kind === "var" || item.kind === "local") return "vars";
            return "other";
        };
        const grouped = new Map();
        for (const item of dataSearchResults) {
            const key = category(item);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(item);
        }
        const ordered = [];
        for (const kind of order) {
            const items = grouped.get(kind);
            if (!items || !items.length) continue;
            const head = document.createElement("div");
            head.className = "data-search-group";
            head.textContent = groups[kind] || kind;
            dropdown.appendChild(head);
            for (const item of items) {
                const row = document.createElement("div");
                row.className = "data-search-item";
                row.dataset.index = String(ordered.length);
                const name = document.createElement("span");
                name.className = "data-search-name";
                name.textContent = dataResultLabel(item);
                const sub = document.createElement("span");
                sub.className = "data-search-kind";
                sub.textContent = dataResultSub(item);
                const counts = document.createElement("span");
                counts.className = "data-search-counts";
                if (item.kind === "struct" || item.fns) {
                    counts.innerHTML = `<span class="count-item" title="functions">${item.fns || 0} fn</span>`;
                } else if (((item.reads || 0) + (item.writes || 0)) === 0) {
                    counts.textContent = "unused";
                } else {
                    counts.innerHTML = `<span class="count-item" title="writes">`
                        + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
                        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
                        + `<path d="M12 20h9"></path>`
                        + `<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"></path>`
                        + `</svg>${item.writes}</span>`
                        + `<span class="count-item" title="reads">`
                        + `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
                        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
                        + `<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path>`
                        + `<circle cx="12" cy="12" r="3"></circle>`
                        + `</svg>${item.reads}</span>`;
                }
                row.appendChild(name);
                row.appendChild(sub);
                row.appendChild(counts);
                row.addEventListener("mouseenter", () => markDataSelection(Number(row.dataset.index)));
                row.addEventListener("click", (e) => {
                    e.stopPropagation();
                    chooseDataResult(item);
                });
                dropdown.appendChild(row);
                ordered.push(item);
            }
        }
        dataSearchResults = ordered;
        dropdown.style.display = "block";
        positionDataDropdown();
        markDataSelection(0);
    }

    function markDataSelection(index) {
        if (!dropdown) return;
        const rows = dropdown.querySelectorAll(".data-search-item");
        rows.forEach((r, i) => r.classList.toggle("active", i === index));
        dataSearchSelection = index;
    }

    function chooseDataResult(item) {
        if (!item) return;
        searchInput.value = item.name;
        hideDropdown();
        countBadge.style.display = "inline-flex";
        countBadge.className = "search-match-count has-matches";
        countBadge.textContent = item.kind;
        if (item.kind === "struct") {
            openStructType(item.groupId);
        } else if (item.kind === "field") {
            openStructMember({
                member: item.member || item.name,
                type: item.type,
                groupId: item.groupId
            });
        } else {
            openStructVariable(item);
        }
    }

    function runDataSearch(query) {
        if (!dataflowClient) return;
        const q = query.trim();
        if (!q) {
            hideDropdown();
            return;
        }
        dataflowClient.search(q, 50).then((results) => {
            renderDataDropdown(results);
        }).catch(() => hideDropdown());
    }

    // Mode toggle
    document.querySelectorAll("#search-mode button").forEach((btn) => {
        btn.addEventListener("click", () => {
            setMode(btn.dataset.mode);
            searchInput.focus();
        });
    });

    searchInput.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        let query = e.target.value;
        if (query.startsWith("@")) {
            if (searchMode !== "data") setMode("data");
            query = query.slice(1);
        }
        if (!query.trim()) {
            hideDropdown();
            if (searchMode === "functions") {
                if (visContainerNode?.clearSearch) visContainerNode.clearSearch();
                updateUI({ count: 0 });
            }
            return;
        }
        debounceTimer = setTimeout(() => {
            if (searchMode === "data") runDataSearch(query);
            else doSearch(query);
        }, 220);
    });

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            clearTimeout(debounceTimer);
            let query = searchInput.value.trim();
            if (searchMode === "data") {
                if (query.startsWith("@")) query = query.slice(1);
                if (dataSearchSelection >= 0 && dataSearchResults[dataSearchSelection]) {
                    chooseDataResult(dataSearchResults[dataSearchSelection]);
                } else if (query) {
                    runDataSearch(query);
                }
                return;
            }
            if (!query) return;
            const currentState = visContainerNode?.getSearchState?.();
            if (currentState && currentState.query === query.toLowerCase() && currentState.matches.length > 0) {
                updateUI(e.shiftKey ? visContainerNode.prevMatch() : visContainerNode.nextMatch());
            } else {
                doSearch(query);
            }
        } else if (e.key === "Escape") {
            searchInput.value = "";
            hideDropdown();
            if (visContainerNode?.clearSearch) visContainerNode.clearSearch();
            updateUI({ count: 0 });
            searchInput.blur();
        } else if (searchMode === "data" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            if (!dataSearchResults.length) return;
            const delta = e.key === "ArrowDown" ? 1 : -1;
            let next = dataSearchSelection + delta;
            if (next < 0) next = dataSearchResults.length - 1;
            if (next >= dataSearchResults.length) next = 0;
            markDataSelection(next);
        }
    });

    btnNext?.addEventListener("click", () => {
        if (searchMode === "functions" && visContainerNode?.nextMatch) updateUI(visContainerNode.nextMatch());
    });
    btnPrev?.addEventListener("click", () => {
        if (searchMode === "functions" && visContainerNode?.prevMatch) updateUI(visContainerNode.prevMatch());
    });
    btnClear?.addEventListener("click", () => {
        searchInput.value = "";
        hideDropdown();
        if (visContainerNode?.clearSearch) visContainerNode.clearSearch();
        updateUI({ count: 0 });
        searchInput.focus();
    });

    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    });

    setMode("functions");
}

// ---------------------------------------------------------------------------
// Parameter pill + card
// ---------------------------------------------------------------------------

function recordForNode(nodeId) {
    if (!graphMeta || !graphMeta.nodeRecords) return null;
    return graphMeta.nodeRecords[nodeId] || null;
}

function showParamPill(nodeId) {
    const rec = recordForNode(nodeId);
    const pill = document.getElementById("param-pill");
    if (!pill || !rec || rec.external || !rec.paramCount) {
        hideParamPill();
        return;
    }
    paramPillNodeId = nodeId;
    pill.innerHTML = "";
    const label = document.createElement("span");
    label.className = "param-pill-label";
    label.textContent = `⟨${rec.paramCount}⟩ params`;
    const bar = document.createElement("span");
    bar.className = "param-pill-bar";
    const ins = document.createElement("span");
    ins.className = "param-pill-in";
    ins.style.width = `${Math.min(100, Math.round((rec.readCount / Math.max(1, rec.readCount + rec.writeCount)) * 100))}%`;
    const outs = document.createElement("span");
    outs.className = "param-pill-out";
    bar.appendChild(ins);
    bar.appendChild(outs);
    pill.appendChild(label);
    pill.appendChild(bar);
    pill.style.display = "inline-flex";
    pill.onclick = (e) => {
        e.stopPropagation();
        openParamCard(nodeId, false);
    };
    updateOverlayPositions();
}

function hideParamPill() {
    paramPillNodeId = null;
    const pill = document.getElementById("param-pill");
    if (pill) pill.style.display = "none";
}

function refreshMainHighlight() {
    const vis = document.getElementById("visualization");
    if (vis && typeof vis.refreshHighlight === "function") vis.refreshHighlight();
}

function openParamCard(nodeId, pin, sourceContainer) {
    const rec = recordForNode(nodeId);
    if (!rec || rec.external) return;
    if (paramCardPinned && paramCardNodeId !== null && paramCardNodeId !== nodeId && !pin) {
        // A pinned card stays; a new unpinned card replaces the previous one.
        return;
    }
    paramCardNodeId = nodeId;
    paramCardPinned = !!pin || paramCardPinned;
    paramCardSourceContainer = sourceContainer || null;
    const card = document.getElementById("param-card");
    if (!card) return;
    card.style.display = "flex";
    card.innerHTML = `<div class="param-card-loading">Loading parameters…</div>`;
    updateOverlayPositions();
    // While the card is open, keep the whole graph at full opacity; the
    // selected node is still identifiable by its focus colour.
    refreshMainHighlight();

    if (!dataflowClient) {
        renderParamCard(rec, null);
        return;
    }
    dataflowClient.getParams(rec.functionId, rec.shard)
        .then((data) => {
            if (paramCardNodeId !== nodeId) return;
            paramCardData = data;
            renderParamCard(rec, data);
        })
        .catch((err) => {
            if (paramCardNodeId !== nodeId) return;
            console.warn(`Could not load parameters for ${rec.name}:`, err);
            renderParamCard(rec, null, err);
        });
}

function closeParamCard() {
    paramCardNodeId = null;
    paramCardPinned = false;
    paramCardData = null;
    paramCardSourceContainer = null;
    const card = document.getElementById("param-card");
    if (card) card.style.display = "none";
    refreshMainHighlight();
}
window.closeParamCard = closeParamCard;

// ---------------------------------------------------------------------------
// Struct explorer entry points (search, parameter cards, lifecycle rows)
// ---------------------------------------------------------------------------

const STRUCT_INTRINSIC_TYPES = new Set([
    "integer", "real", "logical", "character", "complex", "double",
    "doubleprecision", "byte", "int", "long", "short", "float", "bool",
    "void", "c_ptr", "c_funptr", "c_int", "c_double", "c_float", "c_char",
    "c_bool", "c_size_t", "c_int64_t", "c_int32_t", "c_loc"
]);

function structBaseType(type) {
    let text = String(type || "").trim();
    if (!text) return "";
    const low = text.toLowerCase();
    if (low.startsWith("type(") || low.startsWith("class(")) {
        text = text.slice(text.indexOf("(") + 1);
        if (text.endsWith(")")) text = text.slice(0, -1);
    }
    text = text.split("(")[0].trim();
    return text.split("::").pop().toLowerCase();
}

function openStructType(typeKey) {
    const manager = window.detailPanelManager;
    if (!manager) return;
    const key = structBaseType(typeKey);
    if (!key) return;
    manager.openStruct({ kind: "type", typeKey: key });
}

function openStructMember(item) {
    const manager = window.detailPanelManager;
    if (!manager || !item || !item.member) return;
    const member = item.member.toLowerCase();
    manager.openStruct({
        kind: "member",
        member,
        typeKey: member.split("%")[0],
        route: item.route || null,
        gid: item.groupId || null,
        routeMode: item.route ? "route" : "all"
    });
}

function openStructVariable(item) {
    const manager = window.detailPanelManager;
    if (!manager || !item) return;
    const typeKey = structBaseType(item.type);
    if (!dataflowClient) {
        manager.openStruct({ kind: "variable", entity: null, name: item.name,
            typeKey, gid: item.groupId });
        return;
    }
    dataflowClient.getStructs().then((structs) => {
        const rec = structs && structs.types ? structs.types[typeKey] : null;
        if (rec && !rec.value) {
            manager.openStruct({ kind: "type", typeKey, holderId: null });
        } else {
            manager.openStruct({ kind: "variable", entity: null, name: item.name,
                typeKey, gid: item.groupId });
        }
    }).catch(() => {
        manager.openStruct({ kind: "variable", entity: null, name: item.name,
            typeKey, gid: item.groupId });
    });
}

function openStructParam(fnId, paramName, typeName, fnName) {
    const manager = window.detailPanelManager;
    if (!manager) return;
    const typeKey = structBaseType(typeName);
    if (!typeKey || STRUCT_INTRINSIC_TYPES.has(typeKey)) return;
    const fnNode = parsedGraph && parsedGraph.meta && parsedGraph.meta.functionToNode
        ? parsedGraph.meta.functionToNode.get(fnId)
        : null;
    manager.openStruct({ kind: "type", typeKey }, {
        fnNode: fnNode ?? null,
        fnName: fnName || paramName
    });
}
window.openStructParam = openStructParam;
window.openStructType = openStructType;
window.openStructMember = openStructMember;

function findStructMemberForRoute(structs, route) {
    if (!structs || !structs.types || !route) return null;
    for (const [typeKey, rec] of Object.entries(structs.types)) {
        for (const [member, routes] of Object.entries(rec.routes || {})) {
            if ((routes || []).some((r) => r[0] === route)) {
                return { typeKey, member, route };
            }
        }
    }
    return null;
}

function openStructEntity(entity) {
    const text = String(entity || "");
    if (!text) return;
    const kind = text.split(":", 1)[0];
    if (kind === "field") {
        const route = text.slice(text.indexOf(":") + 1);
        if (!dataflowClient) return;
        dataflowClient.getStructs().then(async (structs) => {
            const hit = findStructMemberForRoute(structs, route);
            if (hit) {
                openStructMember(hit);
                return;
            }
            // Unresolved paths keep their raw spelling; find their lifecycle
            // group through the search index so the row is still usable.
            let gid = null;
            try {
                const results = await dataflowClient.search(route, 80);
                const match = (results || []).find((r) => r.kind === "field"
                    && (r.member === route || r.name === route));
                if (match) gid = match.groupId;
            } catch (err) { /* optional */ }
            window.detailPanelManager?.openStruct({
                kind: "member", member: route, typeKey: route.split("%")[0],
                gid, route: null, routeMode: "all"
            });
        }).catch(() => {});
        return;
    }
    if (kind === "param" || kind === "var" || kind === "local") {
        if (!dataflowClient) return;
        dataflowClient.getStructs().then((structs) => {
            if (!structs || !structs.types) return;
            const short = text.split("::").pop();
            // Exact entity id wins across the whole model. A name-only match
            // (e.g. `this` or `pt`) must never shadow the real holder of a
            // variable in a later type.
            let nameMatch = null;
            for (const [typeKey, rec] of Object.entries(structs.types)) {
                const holders = rec.holders || [];
                const exact = holders.find((h) => h.id === text);
                if (exact) {
                    window.detailPanelManager?.openStruct({
                        kind: "variable", entity: text, name: exact.name,
                        typeKey, gid: null, holderId: exact.id
                    });
                    return;
                }
                if (!nameMatch) {
                    const byName = holders.find((h) => h.name === short);
                    if (byName) nameMatch = { typeKey, holder: byName };
                }
            }
            if (nameMatch) {
                window.detailPanelManager?.openStruct({
                    kind: "variable", entity: text, name: nameMatch.holder.name,
                    typeKey: nameMatch.typeKey, gid: null,
                    holderId: nameMatch.holder.id
                });
            }
            const member = findStructMemberForRoute(structs, text);
            if (member) openStructMember(member);
        }).catch(() => {});
    }
}
window.openStructEntity = openStructEntity;

function openFunctionData(nodeId) {
    const manager = window.detailPanelManager;
    const rec = recordForNode(nodeId);
    if (!manager || !rec) return;
    manager.openStruct({
        kind: "function",
        fnNode: nodeId,
        fnId: rec.functionId,
        name: rec.name || String(nodeId)
    });
}
window.openFunctionData = openFunctionData;

// Used by the side panel to close a card that belongs to a tab being closed.
window.isParamCardAnchoredTo = (container) => {
    if (!paramCardSourceContainer || !container) return false;
    return container === paramCardSourceContainer ||
        (typeof container.contains === "function" && container.contains(paramCardSourceContainer));
};

function graphCallersOf(nodeId) {
    if (!parsedGraph || !parsedGraph.edges || nodeId === undefined || nodeId === null) return [];
    const records = (parsedGraph.meta && parsedGraph.meta.nodeRecords) || [];
    const callers = [];
    for (const [from, targets] of parsedGraph.edges) {
        if (targets.has(nodeId)) callers.push(from);
    }
    return callers.map((id) => {
        const rec = records[id] || {};
        return { n: rec.name || String(id), f: rec.file || "", l: rec.line || 0, node: id };
    }).sort((a, b) => (a.f || "").localeCompare(b.f || "") || (a.l || 0) - (b.l || 0));
}

function buildParamNoPathDetails(data, param) {
    const box = document.createElement("div");
    box.className = "param-no-path-details";

    const declared = document.createElement("div");
    declared.className = "param-no-path-loc";
    const file = (data && (data.file || data.abs)) || "";
    const line = param.l ? `:${param.l}` : "";
    declared.textContent = file
        ? `Declared at ${file}${line}`
        : "Declaration location not recorded";
    box.appendChild(declared);

    const explicitSources = Array.isArray(param.src) ? param.src : [];
    const nodeId = parsedGraph && parsedGraph.meta && parsedGraph.meta.functionToNode
        ? parsedGraph.meta.functionToNode.get(data && data.id)
        : null;
    const sources = explicitSources.length ? explicitSources : graphCallersOf(nodeId).slice(0, 8);

    if (sources.length) {
        const label = document.createElement("div");
        label.className = "param-no-path-label";
        label.textContent = explicitSources.length
            ? "Passed in from:"
            : "Routine callers (call argument binding not resolved):";
        box.appendChild(label);

        const list = document.createElement("ul");
        list.className = "param-no-path-sources";
        sources.forEach((source) => {
            const item = document.createElement("li");
            const loc = source.f ? `${source.f}${source.l ? `:${source.l}` : ""}` : "";
            const name = source.n || "caller";
            item.textContent = loc ? `${name} — ${loc}` : name;
            list.appendChild(item);
        });
        box.appendChild(list);
    } else {
        const none = document.createElement("div");
        none.className = "param-no-path-label";
        none.textContent = "No caller binding was recorded for this parameter.";
        box.appendChild(none);
    }

    const note = document.createElement("div");
    note.className = "param-no-path-note";
    note.textContent = "No read/write/pass events were recorded, so there is no lifecycle path to open.";
    box.appendChild(note);
    return box;
}

function updateParamExpandState(row) {
    const button = row.querySelector(".param-expand");
    if (button) {
        button.setAttribute("aria-expanded", row.classList.contains("is-expanded") ? "true" : "false");
    }
}

function toggleParamNoPathDetails(row, data, param) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains("param-no-path-details")) {
        next.remove();
        row.classList.remove("is-expanded");
        updateParamExpandState(row);
        return;
    }
    const card = row.closest(".param-card");
    if (card) {
        card.querySelectorAll(".param-row.is-expanded").forEach((other) => {
            other.classList.remove("is-expanded");
            updateParamExpandState(other);
        });
        card.querySelectorAll(".param-no-path-details").forEach((el) => el.remove());
    }
    row.classList.add("is-expanded");
    row.after(buildParamNoPathDetails(data, param));
    updateParamExpandState(row);
}

function renderParamCard(rec, data, error) {
    const card = document.getElementById("param-card");
    if (!card) return;
    card.innerHTML = "";

    const head = document.createElement("div");
    head.className = "param-card-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "param-card-title-wrap";
    const title = document.createElement("div");
    title.className = "param-card-title";
    title.textContent = data?.name || rec.name;
    const location = document.createElement("div");
    location.className = "param-card-location";
    const file = data?.file || rec.file || "";
    const line = data?.line || rec.line || 0;
    location.textContent = line ? `${file}:${line}` : file;
    location.title = `${data?.abs || ""}`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(location);
    head.appendChild(titleWrap);

    const badge = document.createElement("span");
    badge.className = `exec-badge exec-${(data?.exec || rec.exec || "unknown").replace(/[^a-z_]/g, "")}`;
    badge.textContent = data?.exec || rec.exec || "unknown";
    head.appendChild(badge);

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "param-card-icon" + (paramCardPinned ? " active" : "");
    pinBtn.title = "Pin card";
    pinBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
        + `<path d="M9 3h6l-1 5 4 4v2H6v-2l4-4-1-5Z"></path>`
        + `<path d="M12 14v7"></path></svg>`;
    pinBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        paramCardPinned = !paramCardPinned;
        pinBtn.classList.toggle("active", paramCardPinned);
    });
    head.appendChild(pinBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "param-card-icon";
    closeBtn.title = "Close (Esc)";
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
        + `<path d="M6 6l12 12M18 6 6 18"></path></svg>`;
    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeParamCard();
    });
    head.appendChild(closeBtn);
    card.appendChild(head);

    if (!data) {
        const msg = document.createElement("div");
        msg.className = "param-card-empty";
        msg.textContent = error
            ? `Could not load parameter data (${error.message || error}).`
            : "No parameter data for this node.";
        card.appendChild(msg);
        return;
    }

    const rows = document.createElement("div");
    rows.className = "param-card-rows";
    (data.params || []).forEach((param) => {
        const noPath = !!param.np;
        const row = document.createElement("div");
        row.className = "param-row" + (noPath ? " param-row-no-path" : "");
        row.title = noPath
            ? "Click to see its declaration and callers; no read/write/pass path was recorded"
            : "Click to trace this parameter back to its origin";

        const chip = document.createElement("span");
        chip.className = `intent-chip intent-${(param.i || "none").toLowerCase()}`;
        chip.textContent = param.i || "—";
        row.appendChild(chip);

        const name = document.createElement("span");
        name.className = "param-name";
        name.textContent = param.n;
        row.appendChild(name);

        const type = document.createElement("span");
        type.className = "param-type";
        const rank = param.r ? `(${param.r})` : "";
        type.textContent = `: ${param.t || "?"}${rank}`;
        row.appendChild(type);

        const structType = structBaseType(param.t);
        if (structType && !STRUCT_INTRINSIC_TYPES.has(structType)) {
            const structBtn = document.createElement("button");
            structBtn.type = "button";
            structBtn.className = "param-struct";
            structBtn.title = `Browse ${structType} and what this function uses`;
            structBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
                + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
                + `<rect x="3" y="3" width="7" height="7" rx="1"></rect>`
                + `<rect x="14" y="3" width="7" height="7" rx="1"></rect>`
                + `<rect x="3" y="14" width="7" height="7" rx="1"></rect>`
                + `<rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>`;
            structBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                openStructParam(data.id, param.n, param.t, data.name);
            });
            row.appendChild(structBtn);
        }

        if (intentMismatch(param)) {
            const warn = document.createElement("span");
            warn.className = "param-warn";
            warn.title = `Declared ${formatIntent(param.i)}, inferred ${formatIntent(param.ii)}`;
            warn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
                + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
                + `<path d="m12 3 9 17H3L12 3Z"></path>`
                + `<path d="M12 9v5"></path><path d="M12 17h.01"></path></svg>`;
            row.appendChild(warn);
        }

        if (noPath) {
            const noPathBadge = document.createElement("span");
            noPathBadge.className = "param-no-path";
            noPathBadge.textContent = "no path";
            noPathBadge.title = "No read/write/pass events were recorded for this parameter";
            row.appendChild(noPathBadge);
        }

        if (noPath) {
            const expand = document.createElement("button");
            expand.type = "button";
            expand.className = "param-expand";
            expand.title = "Open declaration and callers";
            expand.setAttribute("aria-expanded", "false");
            expand.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
                + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
                + `<path d="M5 8h14l-7 9-7-9Z"></path></svg>`;
            expand.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleParamNoPathDetails(row, data, param);
            });
            row.appendChild(expand);
        } else {
            const flow = document.createElement("button");
            flow.type = "button";
            flow.className = "param-flow";
            flow.title = "Show the full flow";
            flow.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
                + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
                + `<path d="M8 3H3v5"></path><path d="M16 3h5v5"></path>`
                + `<path d="M8 21H3v-5"></path><path d="M16 21h5v-5"></path></svg>`;
            flow.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!param.g) return;
                startTrace(param.g, "full", null, `${data.name} · ${param.n}`);
            });
            row.appendChild(flow);
        }

        row.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!param.g) return;
            if (noPath) {
                toggleParamNoPathDetails(row, data, param);
                return;
            }
            const entity = `param:${data.id}::${param.n}`;
            startTrace(param.g, "backward", entity, `${data.name} · ${param.n}`);
        });
        rows.appendChild(row);
    });
    card.appendChild(rows);

    const ret = data.result || null;
    const retRow = document.createElement("div");
    retRow.className = "param-returns";
    const retLabel = document.createElement("span");
    retLabel.className = "param-returns-label";
    retLabel.textContent = "Returns";
    const retValue = document.createElement("span");
    retValue.textContent = ret ? (typeof ret === "string" ? ret : (ret.type || ret.name || "—")) : "—";
    retRow.appendChild(retLabel);
    retRow.appendChild(retValue);
    card.appendChild(retRow);
    updateOverlayPositions();
}

function updateOverlayPositions() {
    if (!mainViewContext) return;
    const { state } = mainViewContext;
    if (!state) return;
    const transform = state.currentZoomTransform || d3.zoomIdentity;
    const viewport = document.getElementById("visualization");
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();

    const positionFor = (nodeId) => {
        const pos = state.nodePositions && state.nodePositions.get(nodeId);
        const dims = state.nodeDims && state.nodeDims.get(nodeId);
        if (!pos) return null;
        const x = rect.left + pos.x * transform.k + transform.x;
        const y = rect.top + pos.y * transform.k + transform.y;
        return { x, y, w: (dims ? dims.w : 80) * transform.k, h: (dims ? dims.h : 30) * transform.k };
    };

    // A card opened from a side-panel tab follows that tab's graph. Fall back
    // to the main view when the tab was closed or the node has no position.
    const anchorFor = (nodeId, containerEl) => {
        if (containerEl && containerEl.isConnected && containerEl.getClientRects().length &&
            typeof containerEl.getNodeScreenAnchor === "function") {
            const anchor = containerEl.getNodeScreenAnchor(nodeId);
            if (anchor) return anchor;
        }
        return positionFor(nodeId);
    };

    // Overlays belong to the graph pane; never let them cover the docked
    // inspector when it is open.
    const leftPanelEl = document.getElementById("left-panel");
    const paneRect = leftPanelEl ? leftPanelEl.getBoundingClientRect() : rect;
    const paneLeft = paneRect.left + 8;
    const paneRight = paneRect.right - 8;

    const pill = document.getElementById("param-pill");
    if (pill && paramPillNodeId !== null) {
        const p = positionFor(paramPillNodeId);
        if (p) {
            const pillWidth = pill.offsetWidth || 90;
            let pillLeft = p.x + p.w / 2 + 8;
            if (pillLeft + pillWidth > paneRight) {
                pillLeft = p.x - p.w / 2 - pillWidth - 8;
            }
            pillLeft = Math.max(paneLeft, Math.min(pillLeft, paneRight - pillWidth));
            pill.style.left = `${pillLeft}px`;
            pill.style.top = `${p.y - p.h / 2}px`;
        } else {
            pill.style.display = "none";
        }
    }

    const card = document.getElementById("param-card");
    if (card && paramCardNodeId !== null && card.style.display !== "none") {
        // Keep the card inside the graph pane so it can never sit on top of the
        // side panel. If the pane is narrow, shrink the card instead of
        // dropping it (which used to make "Show parameters" look broken).
        const available = Math.max(200, paneRight - paneLeft);
        card.style.maxWidth = `${available}px`;
        const width = Math.min(card.offsetWidth || 360, available);
        const height = card.offsetHeight || 300;

        const p = anchorFor(paramCardNodeId, paramCardSourceContainer);
        let left;
        let top;
        if (p) {
            left = p.x + p.w / 2 + 14;
            if (left + width > paneRight) left = p.x - p.w / 2 - width - 14;
            top = p.y - p.h / 2;
        } else {
            // The source node is off-screen or inside a closed box. Still show
            // the card, docked to the top-right corner of the graph pane.
            left = paneRight - width;
            top = rect.top + 16;
        }
        left = Math.max(paneLeft, Math.min(left, paneRight - width));
        const graphTop = rect.top + 12;
        const graphBottom = rect.bottom - 12;
        top = Math.max(graphTop, Math.min(top, Math.max(graphTop, graphBottom - height)));
        card.style.left = `${left}px`;
        card.style.top = `${top}px`;
    }
}
window.addEventListener("resize", () => updateOverlayPositions());

// ---------------------------------------------------------------------------
// Trace mode
// ---------------------------------------------------------------------------

function startTrace(groupId, mode, paramEntity, label) {
    if (!dataflowClient || !groupId) return;
    const container = document.getElementById("visualization");
    if (!container) return;
    hideParamPill();
    dataflowClient.getTrace(groupId).then((trace) => {
        if (!trace) {
            showToast("Trace data not available for this entity.");
            return;
        }
        let effectiveMode = mode === "backward" ? "backward" : "full";
        if (effectiveMode === "backward" && !traceHasBackwardPath(trace, paramEntity)) {
            effectiveMode = "full";
        }
        structHighlightRestore = null;
        currentStructTouch = null;
        currentStructLabel = null;
        currentTrace = trace;
        currentTraceMode = effectiveMode;
        currentParamEntity = paramEntity || null;
        currentTraceGroupId = groupId;
        currentTraceLabel = label || trace.entity;
        const view = buildDataTraceView(trace, effectiveMode, paramEntity);
        currentTraceView = view;
        applyTraceView(view);
        showTraceBar(view);
        if (window.detailPanelManager && typeof window.detailPanelManager.openLifecycle === "function") {
            window.detailPanelManager.openLifecycle(trace, view, paramEntity, currentTraceLabel);
        }
    }).catch((err) => {
        console.warn("trace failed", err);
        showToast(`Could not load trace: ${err.message || err}`);
    });
}

function rebuildCurrentTraceView() {
    if (!currentTrace) return;
    let view;
    if (currentTraceMode === "struct") {
        view = buildStructTouchView(currentStructTouch || {}, currentStructLabel || "struct");
    } else {
        view = buildDataTraceView(currentTrace, currentTraceMode, currentParamEntity);
    }
    if (!includePasses || roleFilterMask !== 15) {
        const nodeIds = new Set();
        const roles = new Map();
        for (const id of view.nodeIds) {
            let mask = view.roles.get(id) || 0;
            if (!includePasses) mask &= ~8;
            mask &= roleFilterMask;
            const visible = mask !== 0 ||
                (view.originFn === id) ||
                (view.steps.has(id) && (roleFilterMask & 8 || roleFilterMask & 1 || roleFilterMask & 2 || roleFilterMask & 4));
            if (visible) {
                nodeIds.add(id);
                roles.set(id, mask);
            }
        }
        const edges = new Set();
        for (const key of view.edges) {
            const [a, b] = key.split("|").map(Number);
            if (nodeIds.has(a) && nodeIds.has(b)) edges.add(key);
        }
        const counts = { create: 0, write: 0, read: 0, pass: 0,
            functions: nodeIds.size, events: view.counts ? view.counts.events : 0 };
        for (const mask of roles.values()) {
            if (mask & 1) counts.create += 1;
            if (mask & 2) counts.write += 1;
            if (mask & 4) counts.read += 1;
            if (mask & 8) counts.pass += 1;
        }
        view = { ...view, nodeIds, roles, edges, counts };
    }
    currentTraceView = view;
    applyTraceView(view);
    showTraceBar(view);
}

function applyTraceView(view) {
    const container = d3.select("#visualization").node();
    if (container && typeof container.setDataTrace === "function") {
        container.setDataTrace(view, currentTraceMode);
    }
    const legend = document.getElementById("trace-legend");
    if (legend) legend.style.display = "flex";
}

function clearTrace() {
    // Clearing an on-demand struct highlight restores the trace that was
    // visible before it was opened (plan §5 "Show on graph").
    if (structHighlightRestore) {
        const restore = structHighlightRestore;
        structHighlightRestore = null;
        currentStructTouch = null;
        currentStructLabel = null;
        if (restore.trace) {
            currentTrace = restore.trace;
            currentTraceView = restore.view;
            currentTraceMode = restore.mode;
            currentParamEntity = restore.paramEntity;
            currentTraceGroupId = restore.groupId;
            currentTraceLabel = restore.label;
            applyTraceView(restore.view);
            showTraceBar(restore.view);
            return;
        }
    }
    currentTrace = null;
    currentTraceView = null;
    currentParamEntity = null;
    currentTraceGroupId = null;
    currentTraceLabel = null;
    currentStructTouch = null;
    currentStructLabel = null;
    const container = d3.select("#visualization").node();
    if (container && typeof container.clearDataTrace === "function") container.clearDataTrace();
    const bar = document.getElementById("trace-bar");
    if (bar) bar.style.display = "none";
    const legend = document.getElementById("trace-legend");
    if (legend) legend.style.display = "none";
}

function buildStructTouchView(touch, label) {
    const fn = touch.fn || [];
    const nodeIds = new Set();
    const roles = new Map();
    let create = 0, write = 0, read = 0, pass = 0;
    for (const entry of fn) {
        const node = entry[0];
        const mask = entry[1] || 0;
        nodeIds.add(node);
        roles.set(node, mask);
        if (mask & 1) create += 1;
        if (mask & 2) write += 1;
        if (mask & 4) read += 1;
        if (mask & 8) pass += 1;
    }
    const edges = new Set((touch.edges || []).map(([a, b]) => `${a}|${b}`));
    const origin = touch.origin || [];
    const originFn = origin[0] !== undefined ? origin[0] : (nodeIds.size ? [...nodeIds][0] : null);
    return {
        trace: null,
        mode: "struct",
        paramEntity: null,
        nodeIds,
        roles,
        edges,
        steps: new Map(),
        nodeEvents: new Map(),
        originFn,
        originFile: origin[2] || "",
        originName: origin[3] || "",
        originLine: origin[1] || 0,
        originCreated: !!(roles.get(originFn) & 1),
        counts: {
            create, write, read, pass,
            functions: nodeIds.size, events: 0
        },
        folderCounts: new Map(touch.folders || []),
        fileCounts: new Map(touch.files || []),
        large: nodeIds.size > 500,
        entity: label,
        kind: "struct"
    };
}

function showStructOnGraph(typeKey, member, label) {
    if (!dataflowClient || !typeKey) return;
    dataflowClient.getStructTouch(typeKey).then((touch) => {
        if (!touch) {
            showToast("No touch set recorded for this type.");
            return;
        }
        const data = member && touch.members && touch.members[member]
            ? touch.members[member]
            : touch;
        const text = label || (member ? member.split("%").pop() : typeKey);
        const view = buildStructTouchView(data, text);
        if (!structHighlightRestore) {
            structHighlightRestore = {
                trace: currentTrace, view: currentTraceView, mode: currentTraceMode,
                paramEntity: currentParamEntity, groupId: currentTraceGroupId,
                label: currentTraceLabel
            };
        }
        currentTrace = {
            id: `struct:${typeKey}:${member || ""}`,
            entity: member ? `field:${member}` : `struct:${typeKey}`,
            kind: "struct", events: [], backward: {}, routes: [],
            origin: { node: view.originFn, line: view.originLine,
                file: view.originFile, name: view.originName }
        };
        currentTraceMode = "struct";
        currentParamEntity = null;
        currentTraceGroupId = null;
        currentTraceLabel = text;
        currentStructTouch = data;
        currentStructLabel = text;
        currentTraceView = view;
        applyTraceView(view);
        showTraceBar(view);
    }).catch(() => showToast("Could not load the struct touch set."));
}
window.showStructOnGraph = showStructOnGraph;

function showTraceBar(view) {
    const bar = document.getElementById("trace-bar");
    if (!bar) return;
    bar.style.display = "flex";
    bar.classList.toggle("trace-bar-large", view.large);
    const title = document.getElementById("trace-entity");
    if (title) {
        title.textContent = currentTraceLabel || view.entity || "trace";
        const linkable = !!(currentTrace && currentTrace.entity &&
            /^(field|param|var|local):/.test(currentTrace.entity));
        title.classList.toggle("struct-link", linkable);
        title.title = linkable ? "Open in the struct explorer" : "";
    }
    const counts = document.getElementById("trace-counts");
    if (counts) {
        const c = view.counts || {};
        counts.textContent = [`${c.create || 0} create`, `${c.write || 0} write`,
            `${c.read || 0} read`, `${c.pass || 0} pass`,
            `${view.nodeIds.size} fn`].join(" · ");
    }
    const backBtn = document.getElementById("trace-mode-backward");
    const fullBtn = document.getElementById("trace-mode-full");
    if (backBtn) {
        backBtn.classList.toggle("active", currentTraceMode === "backward");
        backBtn.disabled = !(currentTrace && currentParamEntity && currentTrace.backward && currentTrace.backward[currentParamEntity]);
    }
    if (fullBtn) fullBtn.classList.toggle("active", currentTraceMode === "full");

    const origin = document.getElementById("trace-origin-name");
    if (origin) {
        const rec = graphMeta && graphMeta.nodeRecords ? graphMeta.nodeRecords[view.originFn] : null;
        const name = (rec && rec.name) || view.originName || "origin";
        const file = view.originFile || "";
        origin.textContent = `${name} · ${shortPath(file)}:${view.originLine || "?"}`;
        origin.title = file ? `${file}:${view.originLine || ""}` : "";
    }
    const jumpBtn = document.getElementById("trace-jump-origin");
    if (jumpBtn) {
        jumpBtn.textContent = view.originCreated ? "Jump to origin" : "Jump to first use";
    }
}

function shortPath(path) {
    if (!path) return "";
    const parts = String(path).split("/");
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

const traceModeBackward = document.getElementById("trace-mode-backward");
if (traceModeBackward) {
    traceModeBackward.addEventListener("click", () => {
        if (!currentTrace || !currentParamEntity || currentTraceMode === "struct") return;
        currentTraceMode = "backward";
        rebuildCurrentTraceView();
    });
}
const traceModeFull = document.getElementById("trace-mode-full");
if (traceModeFull) {
    traceModeFull.addEventListener("click", () => {
        if (currentTraceMode === "struct") return;
        currentTraceMode = "full";
        rebuildCurrentTraceView();
    });
}
const traceClose = document.getElementById("trace-close");
if (traceClose) traceClose.addEventListener("click", clearTrace);
const traceEntityEl = document.getElementById("trace-entity");
if (traceEntityEl) {
    traceEntityEl.addEventListener("click", () => {
        if (currentTrace && currentTrace.entity &&
            typeof window.openStructEntity === "function") {
            window.openStructEntity(currentTrace.entity);
        }
    });
}
const traceJump = document.getElementById("trace-jump-origin");
if (traceJump) {
    traceJump.addEventListener("click", () => {
        if (!currentTraceView) return;
        const container = d3.select("#visualization").node();
        if (container && typeof container.centerNode === "function") container.centerNode(currentTraceView.originFn, 0.9);
        // Do not select the node here: the trace overlay already highlights it,
        // and a selection would add the whole call-graph closure on top.
    });
}
const traceInclude = document.getElementById("trace-include-propagated");
if (traceInclude) {
    traceInclude.addEventListener("change", (e) => {
        includePasses = e.target.checked;
        rebuildCurrentTraceView();
    });
}
document.querySelectorAll("#trace-role-filters input").forEach((cb) => {
    cb.addEventListener("change", () => {
        roleFilterMask = 0;
        document.querySelectorAll("#trace-role-filters input").forEach((box) => {
            if (box.checked) roleFilterMask |= Number(box.value);
        });
        rebuildCurrentTraceView();
    });
});

// ---------------------------------------------------------------------------
// Mini docs / Info Popup
// ---------------------------------------------------------------------------
const INFO_SEEN_KEY = "iconVisInfoSeen";

function openInfoPopup() {
    const overlay = document.getElementById("info-overlay");
    if (!overlay) return;
    overlay.classList.add("open");
}

function closeInfoPopup() {
    const overlay = document.getElementById("info-overlay");
    if (!overlay) return;
    overlay.classList.remove("open");
}

const infoBtn = document.getElementById("info-btn");
if (infoBtn) infoBtn.addEventListener("click", openInfoPopup);

const infoOverlay = document.getElementById("info-overlay");
if (infoOverlay) {
    infoOverlay.addEventListener("click", (e) => {
        if (e.target === infoOverlay) closeInfoPopup();
    });
}
const infoCloseBtn = document.getElementById("info-popup-close");
if (infoCloseBtn) infoCloseBtn.addEventListener("click", closeInfoPopup);

try {
    if (localStorage.getItem(INFO_SEEN_KEY) !== "1") {
        localStorage.setItem(INFO_SEEN_KEY, "1");
        openInfoPopup();
    }
} catch (err) {
    openInfoPopup();
}

// ---------------------------------------------------------------------------
// Small toast for failures (trace shard missing, worker error, ...)
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(message) {
    let toast = document.getElementById("graph-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "graph-toast";
        toast.className = "graph-toast";
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}
window.showGraphToast = showToast;
