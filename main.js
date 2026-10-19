const ROOT_FILE = "icon.f90";
const ROOT_FUNCTION = "__MAIN__";

// Keeps the pristine graph and the live main-view state so the graph can be
// rebuilt after a folder/file is hidden or the "Show Hidden" option changes.
let mainViewContext = null;

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
        // Caller/callee roles for the main view, so its node colours match the
        // focused side-panel graph of the active tab.
        window.getFullRoleMap = function(nodeId) {
            return computeRoleMapFromEdges(nodeId, fullEdgesMap, fullReverseEdgesMap);
        };

        if (window.DetailPanelManager) {
            window.detailPanelManager = new DetailPanelManager();
            window.detailPanelManager.init(pristineNodes, pristineEdges);
        }

        // --- MAIN VIEW MODE ---
        // Always build the view from the pristine data: buildLevels mutates the
        // maps it is given (adds dummy nodes and rewrites the edge map).
        renderMainMode(pristineNodes, pristineEdges);
    })
    .catch((error) => {
        renderError(error.message);
    });

function findRootId(nodes) {
    for (const [id, label] of nodes.entries()) {
        const labelInfo = parseNodeLabel(label);
        const functionName = labelInfo.lines[labelInfo.lines.length - 1];
        if (labelInfo.file === ROOT_FILE && functionName === ROOT_FUNCTION) {
            return id;
        }
    }
    return null;
}

function renderMainMode(pristineNodes, pristineEdges) {
    const rootId = findRootId(pristineNodes);
    if (!rootId) {
        renderError("Could not find icon.f90\\n__MAIN__ in callgraph.dot.");
        return;
    }

    // Never let the hidden filter hide the root item: the graph would lose its
    // starting point. Both the context menu and this guard use mainRootInfo.
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

    mainViewContext = { rootId, pristineNodes, pristineEdges, container, state, options };

    renderGraph(levels, depthById, nodes, edges, container, state, options);

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

// Rebuild the main graph after the hidden folders/files changed. The layout is
// recomputed from the pristine graph so hidden nodes stop reserving space.
function rebuildMainView() {
    if (!mainViewContext) return;

    const { rootId, pristineNodes, pristineEdges, container, state, options } = mainViewContext;
    const nodes = cloneNodes(pristineNodes);
    const edges = cloneEdges(pristineEdges);
    const { levels, depthById } = buildLevels(rootId, edges, nodes);

    state.currentGraphData = { levels, depthById, nodes, edges };
    state.cachedLayout = null;
    state.searchState = null;
    // Keep the current camera (zoom + pan position) instead of fitting the
    // rebuilt graph back to the screen. Hiding a folder should not throw the
    // user out of the area they were inspecting.
    state.needsFitToScreen = false;

    renderGraph(levels, depthById, nodes, edges, container, state, {
        ...options,
        collapseAllOnInit: false
    });
}

function refreshGraphVisibility() {
    rebuildMainView();

    if (window.detailPanelManager && typeof window.detailPanelManager.refreshVisibility === "function") {
        window.detailPanelManager.refreshVisibility();
    }

    // If a search is active, re-run it against the new graph so stale matches
    // to hidden items are dropped and the match counter is recalculated.
    const searchInput = document.getElementById("graph-search-input");
    if (searchInput && searchInput.value.trim()) {
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
}
window.refreshGraphVisibility = refreshGraphVisibility;

// --- Toggle Controls ---
const toggleEdges = document.getElementById("toggle-edges");
if (toggleEdges) {
    toggleEdges.addEventListener("change", (e) => {
        // When off, edges stay hidden except the highlighted edges of the
        // hovered/clicked node. When on, every edge is shown again.
        d3.selectAll("svg").classed("edges-off", !e.target.checked);
        // Re-run culling so the DOM only holds the edges that are actually
        // visible (none/only-highlighted when off, viewport-culled when on).
        applyContainerAction("updateViewportCulling");
        // The compact vertical spacing is reserved only while orthogonal edges
        // are on screen, so toggling Edges changes the layout when orthogonal
        // routing is active. In every other case the geometry is unchanged and
        // we skip the (comparatively expensive) re-layout.
        if (toggleOrthogonal && toggleOrthogonal.checked) {
            applyContainerAction("relayout");
        }
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
        // Switching orthogonal routing on/off changes how much vertical space the
        // layout must reserve between levels, so re-run the full layout (this
        // also re-routes the edges themselves). Applies to the main view and to
        // every rendered graph in the detail panel.
        applyContainerAction("relayout");
    });
}

// --- Hidden Files / Folders ---
// Right-clicking a function, file, or folder offers to hide it. While "Show
// Hidden" is unticked (the default) hidden items are removed from the graph.
// Dimming unhighlighted elements and call-frequency edge thickness are always
// on; only their toolbar toggles were removed.
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
    if (visCombined && typeof visCombined[actionName] === "function") {
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
function closeContextMenu() {
    const ctxMenu = document.getElementById("context-menu");
    if (ctxMenu) ctxMenu.style.display = "none";
}

document.getElementById("ctx-open-tab").addEventListener("click", () => {
    if (contextMenuNodeId && window.detailPanelManager) {
        window.detailPanelManager.openTab(contextMenuNodeId);
    }
    closeContextMenu();
});

document.getElementById("ctx-hide-file").addEventListener("click", () => {
    closeContextMenu();
    if (contextMenuTarget && contextMenuTarget.fileKey) {
        toggleHiddenFile(contextMenuTarget.fileKey);
    }
});

document.getElementById("ctx-hide-folder").addEventListener("click", () => {
    closeContextMenu();
    if (contextMenuTarget && contextMenuTarget.folder) {
        toggleHiddenFolder(contextMenuTarget.folder);
    }
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
        const infoOverlay = document.getElementById("info-overlay");
        if (infoOverlay && infoOverlay.classList.contains("open")) {
            closeInfoPopup();
            return;
        }
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
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    });
}
// --- Mini Docs / Info Popup ---
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
if (infoBtn) {
    infoBtn.addEventListener("click", openInfoPopup);
}

const infoOverlay = document.getElementById("info-overlay");
if (infoOverlay) {
    // Clicking the dimmed backdrop closes the popup.
    infoOverlay.addEventListener("click", (e) => {
        if (e.target === infoOverlay) closeInfoPopup();
    });
}

const infoCloseBtn = document.getElementById("info-popup-close");
if (infoCloseBtn) {
    infoCloseBtn.addEventListener("click", closeInfoPopup);
}

// Show the guide automatically the first time the site is opened.
try {
    if (localStorage.getItem(INFO_SEEN_KEY) !== "1") {
        localStorage.setItem(INFO_SEEN_KEY, "1");
        openInfoPopup();
    }
} catch (err) {
    // localStorage can be unavailable (private mode / file://); show it anyway.
    openInfoPopup();
}
