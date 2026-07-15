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

    // --- Build Callees Graph ---
    const calleeContainer = d3.select("#visualization");
    const calleeState = createGraphState();
    const calleeEdges = cloneEdges(origEdges);
    const calleeNodes = cloneNodes(origNodes);

    const { levels: calleeLevels, depthById: calleeDepth } = buildLevels(nodeId, calleeEdges, calleeNodes);

    if (calleeLevels.length > 1) {
        renderGraph(calleeLevels, calleeDepth, calleeNodes, calleeEdges, calleeContainer, calleeState, { focusNodeId: nodeId });
    } else {
        calleeContainer.append("div").attr("class", "empty-message").text("This function does not call any other functions.");
    }

    // --- Build Callers Graph ---
    const callerContainer = d3.select("#visualization-callers");
    const callerState = createGraphState();
    const reverseEdges = buildReverseEdgeMap(origEdges);
    const callerNodes = cloneNodes(origNodes);

    const { levels: rawCallerLevels, depthById: rawCallerDepth } = buildLevels(nodeId, reverseEdges, callerNodes);

    if (rawCallerLevels.length > 1) {
        // Flip the graph so callers appear above the focused node
        const flipped = flipGraph(rawCallerLevels, rawCallerDepth, reverseEdges);
        renderGraph(flipped.levels, flipped.depthById, callerNodes, flipped.edges, callerContainer, callerState, { focusNodeId: nodeId });
    } else {
        callerContainer.append("div").attr("class", "empty-message").text("No callers found for this function.");
    }

    // --- Tab Switching ---
    const tabCallees = document.getElementById("tab-callees");
    const tabCallers = document.getElementById("tab-callers");
    const visCallees = document.getElementById("visualization");
    const visCallers = document.getElementById("visualization-callers");

    tabCallees.addEventListener("click", () => {
        visCallees.style.display = "block";
        visCallers.style.display = "none";
        tabCallees.classList.add("active");
        tabCallers.classList.remove("active");
    });

    tabCallers.addEventListener("click", () => {
        visCallees.style.display = "none";
        visCallers.style.display = "block";
        tabCallers.classList.add("active");
        tabCallees.classList.remove("active");
    });
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
    });
}

// --- Context Menu Wiring ---
document.getElementById("ctx-open-tab").addEventListener("click", () => {
    if (contextMenuNodeId) {
        window.open(`index.html?nodeId=${encodeURIComponent(contextMenuNodeId)}`, '_blank');
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

// Dismiss on Escape
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const ctxMenu = document.getElementById("context-menu");
        if (ctxMenu) ctxMenu.style.display = "none";
    }
});