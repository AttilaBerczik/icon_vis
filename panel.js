/**
 * panel.js - Manages the in-page split-panel multi-tab sub-graph view
 */

class DetailPanelManager {
    constructor() {
        this.tabs = [];
        this.activeTabId = null;
        this.nodes = null;
        this.edges = null;

        this.splitContainer = null;
        this.leftPanel = null;
        this.resizer = null;
        this.detailPanel = null;
        this.tabBar = null;
        this.contentArea = null;
        this.closePanelBtn = null;

        this.isResizing = false;
        this.defaultPanelWidth = 520;
    }

    init(nodes, edges) {
        this.nodes = nodes;
        this.edges = edges;

        this.splitContainer = document.getElementById("graph-split-container");
        this.leftPanel = document.getElementById("left-panel");
        this.resizer = document.getElementById("panel-resizer");
        this.detailPanel = document.getElementById("detail-panel");
        this.tabBar = document.getElementById("detail-tab-bar");
        this.contentArea = document.getElementById("detail-content-area");
        this.closePanelBtn = document.getElementById("detail-panel-close-btn");

        if (this.closePanelBtn) {
            this.closePanelBtn.addEventListener("click", () => this.closePanel());
        }

        this.initResizer();
    }

    initResizer() {
        if (!this.resizer) return;

        let startX = 0;
        let startWidth = 0;

        const onMouseMove = (e) => {
            if (!this.isResizing) return;
            const containerRect = this.splitContainer.getBoundingClientRect();
            // Calculate new detail panel width from right edge
            let newWidth = containerRect.right - e.clientX;

            // Constrain minimum and maximum width
            const minWidth = 300;
            const maxWidth = containerRect.width - 250;
            newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));

            this.detailPanel.style.flex = `0 0 ${newWidth}px`;
            this.detailPanel.style.width = `${newWidth}px`;
        };

        const onMouseUp = () => {
            if (this.isResizing) {
                this.isResizing = false;
                document.body.classList.remove("resizing");
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            }
        };

        this.resizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            this.isResizing = true;
            document.body.classList.add("resizing");
            startX = e.clientX;
            startWidth = this.detailPanel.offsetWidth;

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });
    }

    openTab(nodeId) {
        if (!this.nodes || !this.nodes.has(nodeId)) {
            console.warn("Node not found:", nodeId);
            return null;
        }

        // Check if tab already exists for this node
        const existingTab = this.tabs.find(t => t.nodeId === nodeId);
        if (existingTab) {
            this.switchTab(existingTab.id);
            // Flash the tab button to indicate it's already open
            existingTab.tabBtn.classList.add("tab-highlight-pulse");
            setTimeout(() => existingTab.tabBtn.classList.remove("tab-highlight-pulse"), 600);
            return existingTab.id;
        }

        // Show panel and resizer if currently hidden
        if (this.detailPanel.style.display === "none" || !this.detailPanel.style.display) {
            this.detailPanel.style.display = "flex";
            this.resizer.style.display = "block";
            if (!this.detailPanel.style.width) {
                const initialWidth = Math.min(this.defaultPanelWidth, window.innerWidth * 0.45);
                this.detailPanel.style.flex = `0 0 ${initialWidth}px`;
                this.detailPanel.style.width = `${initialWidth}px`;
            }
        }

        const rawLabel = this.nodes.get(nodeId);
        const labelInfo = parseNodeLabel(rawLabel);
        const functionName = labelInfo.lines[labelInfo.lines.length - 1];
        const fileName = labelInfo.file || "";
        const displayName = functionName;
        const fullTitle = fileName ? `${functionName} (${fileName})` : functionName;

        const tabId = "tab_" + Date.now() + "_" + Math.floor(Math.random() * 1000);

        // 1. Create Tab Button in Tab Bar
        const tabBtn = document.createElement("div");
        tabBtn.className = "detail-tab";
        tabBtn.title = fullTitle;
        tabBtn.dataset.tabId = tabId;

        const titleSpan = document.createElement("span");
        titleSpan.className = "detail-tab-title";
        titleSpan.textContent = displayName;

        const closeBtn = document.createElement("span");
        closeBtn.className = "detail-tab-close";
        closeBtn.innerHTML = "&times;";
        closeBtn.title = "Close Tab";
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeTab(tabId);
        });

        tabBtn.appendChild(titleSpan);
        tabBtn.appendChild(closeBtn);

        tabBtn.addEventListener("click", () => this.switchTab(tabId));
        tabBtn.addEventListener("auxclick", (e) => {
            if (e.button === 1) { // Middle click
                e.preventDefault();
                this.closeTab(tabId);
            }
        });

        // Deactivate all existing tabs before creating and rendering new tab
        this.tabs.forEach(t => {
            t.tabBtn.classList.remove("active");
            t.contentContainer.style.display = "none";
        });

        tabBtn.classList.add("active");
        this.tabBar.appendChild(tabBtn);

        // 2. Create Content Container in Detail Content Area as active (display: flex)
        // so it has accurate client dimensions when D3 computes viewport size
        const contentContainer = document.createElement("div");
        contentContainer.className = "tab-content-container";
        contentContainer.dataset.tabId = tabId;
        contentContainer.style.display = "flex";
        this.contentArea.appendChild(contentContainer);

        // 3. Render Sub-graph inside content container
        const subGraphState = renderSubGraphInContainer(nodeId, this.nodes, this.edges, contentContainer);

        const tabObj = {
            id: tabId,
            nodeId,
            displayName,
            fullTitle,
            tabBtn,
            contentContainer,
            subGraphState
        };

        this.tabs.push(tabObj);
        this.activeTabId = tabId;

        // Scroll tab bar to make new tab visible
        tabBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });

        return tabId;
    }

    switchTab(tabId) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;

        this.activeTabId = tabId;

        // Update tab buttons
        this.tabs.forEach(t => {
            if (t.id === tabId) {
                t.tabBtn.classList.add("active");
                t.contentContainer.style.display = "flex";
            } else {
                t.tabBtn.classList.remove("active");
                t.contentContainer.style.display = "none";
            }
        });
    }

    closeTab(tabId) {
        const index = this.tabs.findIndex(t => t.id === tabId);
        if (index === -1) return;

        const tab = this.tabs[index];

        // Clean up DOM
        if (tab.tabBtn && tab.tabBtn.parentNode) {
            tab.tabBtn.parentNode.removeChild(tab.tabBtn);
        }
        if (tab.contentContainer && tab.contentContainer.parentNode) {
            tab.contentContainer.parentNode.removeChild(tab.contentContainer);
        }

        this.tabs.splice(index, 1);

        if (this.activeTabId === tabId) {
            if (this.tabs.length > 0) {
                const nextIndex = Math.min(index, this.tabs.length - 1);
                this.switchTab(this.tabs[nextIndex].id);
            } else {
                this.closePanel();
            }
        }
    }

    closePanel() {
        // Remove all tabs and content
        this.tabs.forEach(tab => {
            if (tab.tabBtn && tab.tabBtn.parentNode) {
                tab.tabBtn.parentNode.removeChild(tab.tabBtn);
            }
            if (tab.contentContainer && tab.contentContainer.parentNode) {
                tab.contentContainer.parentNode.removeChild(tab.contentContainer);
            }
        });
        this.tabs = [];
        this.activeTabId = null;

        if (this.detailPanel) {
            this.detailPanel.style.display = "none";
        }
        if (this.resizer) {
            this.resizer.style.display = "none";
        }
    }

    updateEdgeRouting() {
        // Trigger edge updates on all tab visualizations
        const vizNodes = this.contentArea.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (typeof node.updateEdgeRouting === "function") {
                node.updateEdgeRouting();
            }
        });
    }

    expandAll() {
        this.applyActionToActiveTab("expandAll");
    }

    collapseAll() {
        this.applyActionToActiveTab("collapseAll");
    }

    expandFoldersOnly() {
        this.applyActionToActiveTab("expandFoldersOnly");
    }

    applyActionToActiveTab(actionName) {
        if (!this.contentArea) return;
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        if (!activeTab || !activeTab.contentContainer) return;
        const vizNodes = activeTab.contentContainer.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (node.style.display !== "none" && typeof node[actionName] === "function") {
                node[actionName]();
            }
        });
    }
}

/**
 * Renders sub-graph (Callees and Callers) inside a specific container element.
 */
function renderSubGraphInContainer(nodeId, nodes, edges, containerEl) {
    const rawLabel = nodes.get(nodeId);
    const labelInfo = parseNodeLabel(rawLabel);
    const functionName = labelInfo.lines[labelInfo.lines.length - 1];
    const fileName = labelInfo.file || "";
    const displayName = fileName ? `${functionName} (${fileName})` : functionName;

    // Sub-header for Callees / Callers tab navigation
    const subHeader = document.createElement("div");
    subHeader.className = "tab-sub-header";

    const titleEl = document.createElement("div");
    titleEl.className = "tab-sub-title";
    titleEl.textContent = displayName;
    titleEl.title = displayName;

    const navTabs = document.createElement("div");
    navTabs.className = "tab-sub-nav";

    const btnCombined = document.createElement("button");
    btnCombined.className = "tab-sub-btn active";
    btnCombined.textContent = "⇅ Combined";
    btnCombined.title = "Show both Callers (above) and Callees (below)";

    const btnCallees = document.createElement("button");
    btnCallees.className = "tab-sub-btn";
    btnCallees.textContent = "▼ Callees";
    btnCallees.title = "Show only functions called by this node";

    const btnCallers = document.createElement("button");
    btnCallers.className = "tab-sub-btn";
    btnCallers.textContent = "▲ Callers";
    btnCallers.title = "Show only functions that call this node";

    navTabs.appendChild(btnCombined);
    navTabs.appendChild(btnCallees);
    navTabs.appendChild(btnCallers);
    subHeader.appendChild(titleEl);
    subHeader.appendChild(navTabs);
    containerEl.appendChild(subHeader);

    // Body container holding Combined, Callees & Callers viz containers
    const bodyEl = document.createElement("div");
    bodyEl.className = "tab-sub-body";

    const combinedViz = document.createElement("div");
    combinedViz.className = "viz-container tab-viz";
    combinedViz.style.display = "block";

    const calleeViz = document.createElement("div");
    calleeViz.className = "viz-container tab-viz";
    calleeViz.style.display = "none";

    const callerViz = document.createElement("div");
    callerViz.className = "viz-container tab-viz";
    callerViz.style.display = "none";

    bodyEl.appendChild(combinedViz);
    bodyEl.appendChild(calleeViz);
    bodyEl.appendChild(callerViz);
    containerEl.appendChild(bodyEl);

    // Prepare graph data
    const origEdges = cloneEdges(edges);
    const origNodes = cloneNodes(nodes);

    // --- 1. Build Combined Graph (Default on start) ---
    const combinedSel = d3.select(combinedViz);
    const combinedState = createGraphState();
    const combined = buildCombinedGraph(nodeId, origNodes, origEdges);

    if (combined.hasCallers || combined.hasCallees) {
        renderGraph(combined.levels, combined.depthById, combined.nodes, combined.edges, combinedSel, combinedState, { focusNodeId: nodeId });
    } else {
        combinedSel.append("div").attr("class", "empty-message").text("No callers or callees found for this function.");
    }

    // --- 2. Build Callees Graph (Lazy loaded on first click) ---
    let calleeState = null;
    let hasRenderedCallees = false;

    function renderCalleesOnce() {
        if (hasRenderedCallees) return;
        hasRenderedCallees = true;

        const calleeSel = d3.select(calleeViz);
        calleeState = createGraphState();
        const cEdges = cloneEdges(origEdges);
        const cNodes = cloneNodes(origNodes);

        const { levels: calleeLevels, depthById: calleeDepth } = buildLevels(nodeId, cEdges, cNodes);

        if (calleeLevels.length > 1) {
            renderGraph(calleeLevels, calleeDepth, cNodes, cEdges, calleeSel, calleeState, { focusNodeId: nodeId });
        } else {
            calleeSel.append("div").attr("class", "empty-message").text("This function does not call any other functions.");
        }
    }

    // --- 3. Build Callers Graph (Lazy loaded on first click) ---
    let callerState = null;
    let hasRenderedCallers = false;

    function renderCallersOnce() {
        if (hasRenderedCallers) return;
        hasRenderedCallers = true;

        const callerSel = d3.select(callerViz);
        callerState = createGraphState();
        const reverseEdges = buildReverseEdgeMap(origEdges);
        const callerNodes = cloneNodes(origNodes);

        const { levels: rawCallerLevels, depthById: rawCallerDepth } = buildLevels(nodeId, reverseEdges, callerNodes);

        if (rawCallerLevels.length > 1) {
            const flipped = flipGraph(rawCallerLevels, rawCallerDepth, reverseEdges);
            renderGraph(flipped.levels, flipped.depthById, callerNodes, flipped.edges, callerSel, callerState, { focusNodeId: nodeId });
        } else {
            callerSel.append("div").attr("class", "empty-message").text("No callers found for this function.");
        }
    }

    // Sub-tab switching
    function showSubTab(activeType) {
        btnCombined.classList.toggle("active", activeType === "combined");
        btnCallees.classList.toggle("active", activeType === "callees");
        btnCallers.classList.toggle("active", activeType === "callers");

        combinedViz.style.display = activeType === "combined" ? "block" : "none";
        calleeViz.style.display = activeType === "callees" ? "block" : "none";
        callerViz.style.display = activeType === "callers" ? "block" : "none";

        if (activeType === "callees") renderCalleesOnce();
        if (activeType === "callers") renderCallersOnce();
    }

    btnCombined.addEventListener("click", () => showSubTab("combined"));
    btnCallees.addEventListener("click", () => showSubTab("callees"));
    btnCallers.addEventListener("click", () => showSubTab("callers"));

    return { combinedState, getCalleeState: () => calleeState, getCallerState: () => callerState };
}

window.DetailPanelManager = DetailPanelManager;
window.renderSubGraphInContainer = renderSubGraphInContainer;
