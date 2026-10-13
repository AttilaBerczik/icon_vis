const ROOT_FILE = "icon.f90";
const ROOT_FUNCTION = "__MAIN__";

// Detect sub-graph mode from URL parameter
const urlParams = new URLSearchParams(window.location.search);
const targetNodeId = urlParams.get("nodeId");

fetch("callgraph_folders.dot")
    .then((response) => {
        if (!response.ok) {
            throw new Error("Unable to load callgraph.dot");
        }
        return response.text();
    })
    .then((dotText) => {
        const { nodes, edges } = parseDot(dotText);

        // Keep pristine copies of nodes & edges for dynamic sub-graph views
        const pristineNodes = cloneNodes(nodes);
        const pristineEdges = cloneEdges(edges);

        // Build global full graph edge maps for consistent highlight and dimming across all views
        const fullEdgesMap = new Map();
        const fullReverseEdgesMap = new Map();
        for (const e of pristineEdges) {
            if (!fullEdgesMap.has(e.from)) fullEdgesMap.set(e.from, []);
            fullEdgesMap.get(e.from).push(e.to);
            if (!fullReverseEdgesMap.has(e.to)) fullReverseEdgesMap.set(e.to, []);
            fullReverseEdgesMap.get(e.to).push(e.from);
        }
        window.getFullImmediateNeighbors = function(nodeId) {
            return getImmediateNeighbors(nodeId, fullEdgesMap, fullReverseEdgesMap);
        };
        window.getFullAllConnected = function(nodeId) {
            return getAllConnected(nodeId, fullEdgesMap, fullReverseEdgesMap);
        };

        if (window.DetailPanelManager) {
            window.detailPanelManager = new DetailPanelManager();
            window.detailPanelManager.init(pristineNodes, pristineEdges);
        }

        if (targetNodeId) {
            // --- SUB-GRAPH MODE ---
            renderSubGraphMode(targetNodeId, nodes, edges);
        } else {
            // --- MAIN VIEW MODE ---
            renderMainMode(nodes, edges);
        }
    })
    .catch((error) => {
        renderError(error.message);
    });

function renderMainMode(nodes, edges) {
    let rootId = null;
    for (const [id, label] of nodes.entries()) {
        const labelInfo = parseNodeLabel(label);
        const functionName = labelInfo.lines[labelInfo.lines.length - 1];
        if (labelInfo.file === ROOT_FILE && functionName === ROOT_FUNCTION) {
            rootId = id;
            break;
        }
    }
    if (!rootId) {
        renderError("Could not find icon.f90\\n__MAIN__ in callgraph.dot.");
        return;
    }

    const container = d3.select("#visualization");
    const state = createGraphState();

    const { levels, depthById } = buildLevels(rootId, edges, nodes);
    renderGraph(levels, depthById, nodes, edges, container, state, {
        collapseAllOnInit: true,
        onNodeHover: (hId, activeSet) => {
            if (window.detailPanelManager && typeof window.detailPanelManager.highlightNodeHover === "function") {
                window.detailPanelManager.highlightNodeHover(hId, activeSet);
            }
        },
        onNodeMouseOut: () => {
            if (window.detailPanelManager && typeof window.detailPanelManager.clearNodeHover === "function") {
                window.detailPanelManager.clearNodeHover();
            }
        },
        onNodeClick: (cId, activeSet) => {
            if (window.detailPanelManager && typeof window.detailPanelManager.selectNode === "function") {
                window.detailPanelManager.selectNode(cId, activeSet);
            }
        }
    });

    // Seed any remaining unreached folders/files in nodes to ensure they also have locked-in consistent colors
    for (const [id, rawLabel] of nodes.entries()) {
        const labelInfo = parseNodeLabel(rawLabel);
        if (labelInfo.folder && window.getFolderColor) {
            window.getFolderColor(labelInfo.folder);
        }
        const fileKey = makeFileKey(labelInfo.folder, labelInfo.file);
        if (fileKey && window.getFileColor) {
            window.getFileColor(fileKey);
        }
    }

    setupSearchUI(container.node());
}

function renderSubGraphMode(nodeId, nodes, edges) {
    // Check if node exists
    if (!nodes.has(nodeId)) {
        renderError("Node not found: " + nodeId);
        return;
    }

    // Switch UI to sub-graph mode
    document.getElementById("main-header").style.display = "none";
    document.getElementById("subgraph-header").style.display = "flex";

    // Set page title and header
    const rawLabel = nodes.get(nodeId);
    const labelInfo = parseNodeLabel(rawLabel);
    const functionName = labelInfo.lines[labelInfo.lines.length - 1];
    const fileName = labelInfo.file || "";
    const displayName = fileName ? `${functionName} (${fileName})` : functionName;

    document.title = `Call Graph: ${displayName}`;
    document.getElementById("subgraph-node-name").textContent = displayName;

    // Preserve original edges/nodes (buildLevels is destructive)
    const origEdges = cloneEdges(edges);
    const origNodes = cloneNodes(nodes);

    // --- 1. Build Combined Graph (Default on start) ---
    const combinedContainer = d3.select("#visualization");
    const combinedState = createGraphState();
    const combined = buildCombinedGraph(nodeId, origNodes, origEdges);

    const subGraphModeOptions = {
        focusNodeId: nodeId,
        isSubGraph: true,
        onNodeHover: (hId, activeSet) => {
            if (window.detailPanelManager && typeof window.detailPanelManager.highlightNodeHover === "function") {
                window.detailPanelManager.highlightNodeHover(hId, activeSet);
            }
        },
        onNodeMouseOut: () => {
            if (window.detailPanelManager && typeof window.detailPanelManager.clearNodeHover === "function") {
                window.detailPanelManager.clearNodeHover();
            }
        },
        onNodeClick: (cId, activeSet) => {
            if (window.detailPanelManager && typeof window.detailPanelManager.selectNode === "function") {
                window.detailPanelManager.selectNode(cId, activeSet);
            }
        }
    };

    if (combined.hasCallers || combined.hasCallees) {
        renderGraph(combined.levels, combined.depthById, combined.nodes, combined.edges, combinedContainer, combinedState, subGraphModeOptions);
    } else {
        combinedContainer.append("div").attr("class", "empty-message").text("No callers or callees found for this function.");
    }

    // --- 2. Build Callees Graph (Lazy) ---
    const calleeContainer = d3.select("#visualization-callees");
    let calleeState = null;
    let hasRenderedCallees = false;

    function renderCalleesOnce() {
        if (hasRenderedCallees) return;
        hasRenderedCallees = true;
        calleeState = createGraphState();
        const calleeEdges = cloneEdges(origEdges);
        const calleeNodes = cloneNodes(origNodes);
        const { levels: calleeLevels, depthById: calleeDepth } = buildLevels(nodeId, calleeEdges, calleeNodes);

        if (calleeLevels.length > 1) {
            renderGraph(calleeLevels, calleeDepth, calleeNodes, calleeEdges, calleeContainer, calleeState, subGraphModeOptions);
        } else {
            calleeContainer.append("div").attr("class", "empty-message").text("This function does not call any other functions.");
        }
    }

    // --- 3. Build Callers Graph (Lazy) ---
    const callerContainer = d3.select("#visualization-callers");
    let callerState = null;
    let hasRenderedCallers = false;

    function renderCallersOnce() {
        if (hasRenderedCallers) return;
        hasRenderedCallers = true;
        callerState = createGraphState();
        const reverseEdges = buildReverseEdgeMap(origEdges);
        const callerNodes = cloneNodes(origNodes);
        const { levels: rawCallerLevels, depthById: rawCallerDepth } = buildLevels(nodeId, reverseEdges, callerNodes);

        if (rawCallerLevels.length > 1) {
            const flipped = flipGraph(rawCallerLevels, rawCallerDepth, reverseEdges);
            renderGraph(flipped.levels, flipped.depthById, callerNodes, flipped.edges, callerContainer, callerState, subGraphModeOptions);
        } else {
            callerContainer.append("div").attr("class", "empty-message").text("No callers found for this function.");
        }
    }

    // --- Tab Switching ---
    const tabCombined = document.getElementById("tab-combined");
    const tabCallees = document.getElementById("tab-callees");
    const tabCallers = document.getElementById("tab-callers");
    const visCombined = document.getElementById("visualization");
    const visCallees = document.getElementById("visualization-callees");
    const visCallers = document.getElementById("visualization-callers");

    function switchMode(mode) {
        tabCombined?.classList.toggle("active", mode === "combined");
        tabCallees?.classList.toggle("active", mode === "callees");
        tabCallers?.classList.toggle("active", mode === "callers");

        if (visCombined) visCombined.style.display = mode === "combined" ? "block" : "none";
        if (visCallees) visCallees.style.display = mode === "callees" ? "block" : "none";
        if (visCallers) visCallers.style.display = mode === "callers" ? "block" : "none";

        if (mode === "callees") renderCalleesOnce();
        if (mode === "callers") renderCallersOnce();
    }

    if (tabCombined) tabCombined.addEventListener("click", () => switchMode("combined"));
    if (tabCallees) tabCallees.addEventListener("click", () => switchMode("callees"));
    if (tabCallers) tabCallers.addEventListener("click", () => switchMode("callers"));
}

// --- Toggle Controls ---
const toggleEdges = document.getElementById("toggle-edges");
if (toggleEdges) {
    toggleEdges.addEventListener("change", (e) => {
        // When off, edges stay hidden except the highlighted edges of the
        // hovered/clicked node. When on, every edge is shown again.
        d3.selectAll("svg").classed("edges-off", !e.target.checked);
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
    toggleOrthogonal.addEventListener("change", () => {
        // Update edge routing for all visualization containers
        const visNode = d3.select("#visualization").node();
        if (visNode && typeof visNode.updateEdgeRouting === "function") {
            visNode.updateEdgeRouting();
        }
        const visCallers = d3.select("#visualization-callers").node();
        if (visCallers && typeof visCallers.updateEdgeRouting === "function") {
            visCallers.updateEdgeRouting();
        }
        if (window.detailPanelManager) {
            window.detailPanelManager.updateEdgeRouting();
        }
    });
}

// --- Dim Unhighlighted Toggle Control ---
window.dimHighlightEnabled = true;

window.setDimHighlight = function(enabled) {
    window.dimHighlightEnabled = !!enabled;
    const btn = document.getElementById("btn-toggle-dim");
    if (btn) {
        btn.classList.toggle("active", window.dimHighlightEnabled);
        btn.textContent = window.dimHighlightEnabled ? "◐ Dim Others: ON" : "○ Dim Others: OFF";
        btn.title = window.dimHighlightEnabled ?
            "Toggle dimming unhighlighted elements to 50% opacity (currently ON)" :
            "Toggle dimming unhighlighted elements to 50% opacity (currently OFF)";
    }
    // Refresh highlight state on all visualization containers
    const visNodes = [
        document.getElementById("visualization"),
        document.getElementById("visualization-callees"),
        document.getElementById("visualization-callers")
    ];
    visNodes.forEach(node => {
        if (node && typeof node.refreshHighlight === "function") {
            node.refreshHighlight();
        }
    });
    if (window.detailPanelManager && typeof window.detailPanelManager.refreshHighlight === "function") {
        window.detailPanelManager.refreshHighlight();
    }
};

const btnToggleDim = document.getElementById("btn-toggle-dim");
if (btnToggleDim) {
    btnToggleDim.addEventListener("click", () => {
        window.setDimHighlight(!window.dimHighlightEnabled);
    });
}

// --- Expand / Collapse Shorthand Controls ---
function applyContainerAction(actionName) {
    const visCombined = d3.select("#visualization").node();
    const visCallees = d3.select("#visualization-callees").node();
    const visCallers = d3.select("#visualization-callers").node();

    const candidates = [visCombined, visCallees, visCallers].filter(
        node => node && node.style.display !== "none" && typeof node[actionName] === "function"
    );

    if (candidates.length > 0) {
        candidates.forEach(node => node[actionName]());
    } else if (visCombined && typeof visCombined[actionName] === "function") {
        visCombined[actionName]();
    }

    if (window.detailPanelManager && typeof window.detailPanelManager[actionName] === "function") {
        window.detailPanelManager[actionName]();
    }
}

const btnOpenAll = document.getElementById("btn-open-all");
if (btnOpenAll) {
    btnOpenAll.addEventListener("click", () => applyContainerAction("expandAll"));
}

const btnFoldersOnly = document.getElementById("btn-folders-only");
if (btnFoldersOnly) {
    btnFoldersOnly.addEventListener("click", () => applyContainerAction("expandFoldersOnly"));
}

const btnCloseAll = document.getElementById("btn-close-all");
if (btnCloseAll) {
    btnCloseAll.addEventListener("click", () => applyContainerAction("collapseAll"));
}

// --- Context Menu Wiring ---
document.getElementById("ctx-open-tab").addEventListener("click", () => {
    if (contextMenuNodeId) {
        if (window.detailPanelManager) {
            window.detailPanelManager.openTab(contextMenuNodeId);
        } else {
            window.open(`index.html?nodeId=${encodeURIComponent(contextMenuNodeId)}`, '_blank');
        }
    }
    document.getElementById("context-menu").style.display = "none";
});

// Dismiss context menu on click elsewhere
document.addEventListener("click", (e) => {
    const ctxMenu = document.getElementById("context-menu");
    if (ctxMenu && !ctxMenu.contains(e.target)) {
        ctxMenu.style.display = "none";
    }
});

// Dismiss on Escape (first close context menu if open, otherwise close active detail tab)
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const ctxMenu = document.getElementById("context-menu");
        if (ctxMenu && ctxMenu.style.display !== "none") {
            ctxMenu.style.display = "none";
        } else if (window.detailPanelManager && window.detailPanelManager.activeTabId) {
            window.detailPanelManager.closeTab(window.detailPanelManager.activeTabId);
        }
    }
});

// --- Main View Search Bar Controller ---

function setupSearchUI(visContainerNode) {
    const searchInput = document.getElementById("graph-search-input");
    const countBadge = document.getElementById("search-match-count");
    const btnPrev = document.getElementById("search-btn-prev");
    const btnNext = document.getElementById("search-btn-next");
    const btnClear = document.getElementById("search-btn-clear");
    const wrapper = searchInput ? searchInput.closest(".search-input-wrapper") : null;

    if (!searchInput) return;

    let debounceTimer = null;

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
                countBadge.title = "No matching function, file, or folder found";
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
        countBadge.title = currentMatch ? `Match ${currentNum} of ${res.count} [${currentMatch.type}]: ${currentMatch.func} in ${currentMatch.file || currentMatch.folder}` : "";
    }

    function doSearch(query) {
        if (!visContainerNode || typeof visContainerNode.search !== "function") return;
        const res = visContainerNode.search(query);
        updateUI(res);
    }

    searchInput.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        const query = e.target.value;
        if (!query.trim()) {
            if (visContainerNode && typeof visContainerNode.clearSearch === "function") {
                visContainerNode.clearSearch();
            }
            updateUI({ count: 0 });
            return;
        }
        debounceTimer = setTimeout(() => {
            doSearch(query);
        }, 220);
    });

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            clearTimeout(debounceTimer);
            const query = searchInput.value.trim();
            if (!query) return;

            const currentState = visContainerNode?.getSearchState?.();
            if (currentState && currentState.query === query.toLowerCase() && currentState.matches.length > 0) {
                // If query is already active, cycle next (or Shift+Enter for prev)
                const res = e.shiftKey ? visContainerNode.prevMatch() : visContainerNode.nextMatch();
                updateUI(res);
            } else {
                doSearch(query);
            }
        } else if (e.key === "Escape") {
            searchInput.value = "";
            if (visContainerNode && typeof visContainerNode.clearSearch === "function") {
                visContainerNode.clearSearch();
            }
            updateUI({ count: 0 });
            searchInput.blur();
        }
    });

    btnNext?.addEventListener("click", () => {
        if (visContainerNode && typeof visContainerNode.nextMatch === "function") {
            const res = visContainerNode.nextMatch();
            updateUI(res);
        }
    });

    btnPrev?.addEventListener("click", () => {
        if (visContainerNode && typeof visContainerNode.prevMatch === "function") {
            const res = visContainerNode.prevMatch();
            updateUI(res);
        }
    });

    btnClear?.addEventListener("click", () => {
        searchInput.value = "";
        if (visContainerNode && typeof visContainerNode.clearSearch === "function") {
            visContainerNode.clearSearch();
        }
        updateUI({ count: 0 });
        searchInput.focus();
    });

    // Global shortcut Ctrl+F / Cmd+F to focus graph search input
    document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            // Only capture if user is in main view and not in detail panel or another text input
            const mainHeader = document.getElementById("main-header");
            if (mainHeader && mainHeader.style.display !== "none") {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            }
        }
    });
}