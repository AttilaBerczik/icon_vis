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
    renderGraph(levels, depthById, nodes, edges, container, state);
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

    if (combined.hasCallers || combined.hasCallees) {
        renderGraph(combined.levels, combined.depthById, combined.nodes, combined.edges, combinedContainer, combinedState, { focusNodeId: nodeId });
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
            renderGraph(calleeLevels, calleeDepth, calleeNodes, calleeEdges, calleeContainer, calleeState, { focusNodeId: nodeId });
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
            renderGraph(flipped.levels, flipped.depthById, callerNodes, flipped.edges, callerContainer, callerState, { focusNodeId: nodeId });
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
        d3.selectAll(".edges").style("display", e.target.checked ? "block" : "none");
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