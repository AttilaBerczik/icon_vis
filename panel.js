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
        this.selectedNodeId = null;
        this.selectedActiveSet = null;
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

        // The floating parameter card duplicates information that now lives in
        // the docked panel, and used to stay on top of it. Hide it as soon as a
        // tab is opened; it can be reopened from the graph when needed.
        if (typeof window.closeParamCard === "function") window.closeParamCard();

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
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="M6 6l12 12M18 6 6 18"></path></svg>`;
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
        this.notifyActiveNodeChanged(nodeId);

        if (this.selectedNodeId) {
            this.selectNode(this.selectedNodeId, this.selectedActiveSet);
        }

        // Scroll tab bar to make new tab visible
        tabBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });

        return tabId;
    }

    /**
     * Open (or focus) the Lifecycle tab for a precomputed data trace.
     * The tab is independent of function tabs: it lives in the same side panel
     * but has no focused node, so it never changes the main view's role colours.
     */
    openLifecycle(trace, view, paramEntity, titleOverride) {
        if (!trace) return null;
        // Keep the floating parameter card out of the docked panel's way.
        if (typeof window.closeParamCard === "function") window.closeParamCard();
        const key = `lifecycle:${trace.id}:${paramEntity || ""}:${view ? view.mode : "full"}`;
        const existing = this.tabs.find(t => t.lifecycleKey === key);
        if (existing) {
            this.switchTab(existing.id);
            return existing.id;
        }

        if (this.detailPanel.style.display === "none" || !this.detailPanel.style.display) {
            this.detailPanel.style.display = "flex";
            this.resizer.style.display = "block";
            if (!this.detailPanel.style.width) {
                const initialWidth = Math.min(this.defaultPanelWidth, window.innerWidth * 0.45);
                this.detailPanel.style.flex = `0 0 ${initialWidth}px`;
                this.detailPanel.style.width = `${initialWidth}px`;
            }
        }
        const tabId = "tab_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        const label = titleOverride || trace.entity || "Lifecycle";
        const title = shortLifecycleName(label);

        const tabBtn = document.createElement("div");
        tabBtn.className = "detail-tab";
        tabBtn.title = `Lifecycle · ${label}`;
        tabBtn.dataset.tabId = tabId;
        const kindIcon = document.createElement("span");
        kindIcon.className = "tab-kind-icon";
        kindIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="M3 12h4l2-7 4 14 2-7h6"></path></svg>`;
        const titleSpan = document.createElement("span");
        titleSpan.className = "detail-tab-title";
        titleSpan.textContent = title;
        const closeBtn = document.createElement("span");
        closeBtn.className = "detail-tab-close";
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="M6 6l12 12M18 6 6 18"></path></svg>`;
        closeBtn.title = "Close Tab";
        closeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.closeTab(tabId);
        });
        tabBtn.appendChild(kindIcon);
        tabBtn.appendChild(titleSpan);
        tabBtn.appendChild(closeBtn);
        tabBtn.addEventListener("click", () => this.switchTab(tabId));
        tabBtn.addEventListener("auxclick", (e) => {
            if (e.button === 1) {
                e.preventDefault();
                this.closeTab(tabId);
            }
        });

        this.tabs.forEach(t => {
            t.tabBtn.classList.remove("active");
            t.contentContainer.style.display = "none";
        });
        tabBtn.classList.add("active");
        this.tabBar.appendChild(tabBtn);

        const contentContainer = document.createElement("div");
        contentContainer.className = "tab-content-container lifecycle-content";
        contentContainer.dataset.tabId = tabId;
        contentContainer.style.display = "flex";
        this.contentArea.appendChild(contentContainer);

        renderLifecycleInContainer(trace, view, paramEntity, contentContainer, this.nodes);

        const tabObj = {
            id: tabId,
            nodeId: null,
            type: "lifecycle",
            lifecycleKey: key,
            lifecycle: { trace, view, paramEntity, title: label },
            displayName: title,
            fullTitle: `Lifecycle · ${label}`,
            tabBtn,
            contentContainer
        };
        this.tabs.push(tabObj);
        this.activeTabId = tabId;
        this.notifyActiveNodeChanged(null);
        tabBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        return tabId;
    }

    getActiveNodeId() {
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        return activeTab ? activeTab.nodeId : null;
    }

    notifyActiveNodeChanged(nodeId) {
        const leftViz = document.getElementById("visualization");
        if (leftViz && typeof leftViz.setActiveTabNode === "function") {
            leftViz.setActiveTabNode(nodeId);
        }
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

        this.notifyActiveNodeChanged(tab.nodeId);

        // The tab may have been hidden while the global "Edges" toggle changed;
        // refresh its rendered elements now that it is visible again.
        this.updateViewportCulling();

        if (this.selectedNodeId) {
            this.selectNode(this.selectedNodeId, this.selectedActiveSet);
        }
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
        this.notifyActiveNodeChanged(null);

        if (this.detailPanel) {
            this.detailPanel.style.display = "none";
        }
        if (this.resizer) {
            this.resizer.style.display = "none";
        }
    }

    highlightNodeHover(nodeId, activeSet) {
        if (!this.contentArea) return;
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        if (!activeTab || !activeTab.contentContainer) return;
        const vizNodes = activeTab.contentContainer.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (node.style.display !== "none" && typeof node.highlightNodeHover === "function") {
                node.highlightNodeHover(nodeId, activeSet);
            }
        });
    }

    clearNodeHover() {
        if (!this.contentArea) return;
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        if (!activeTab || !activeTab.contentContainer) return;
        const vizNodes = activeTab.contentContainer.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (node.style.display !== "none" && typeof node.clearNodeHover === "function") {
                node.clearNodeHover();
            }
        });
    }

    selectNode(nodeId, activeSet) {
        this.selectedNodeId = nodeId;
        this.selectedActiveSet = activeSet;
        if (!this.contentArea) return;
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        if (!activeTab || !activeTab.contentContainer) return;
        const vizNodes = activeTab.contentContainer.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (node.style.display !== "none" && typeof node.selectNode === "function") {
                node.selectNode(nodeId, activeSet);
            }
        });
    }

    // Rebuild every open tab after hidden folders/files changed. Re-rendering
    // (rather than patching the DOM) lets buildLevels drop the hidden nodes and
    // close the layout gaps they used to occupy.
    refreshVisibility() {
        if (!this.tabs.length) return;

        const descriptors = this.tabs.map(t => ({
            type: t.type || "function",
            nodeId: t.nodeId,
            lifecycle: t.lifecycle || null,
            lifecycleKey: t.lifecycleKey || null
        }));
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        const activeKey = activeTab ? (activeTab.lifecycleKey || activeTab.nodeId) : null;

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

        let activeTabId = null;
        descriptors.forEach(desc => {
            let tabId = null;
            if (desc.type === "lifecycle" && desc.lifecycle) {
                tabId = this.openLifecycle(desc.lifecycle.trace, desc.lifecycle.view,
                    desc.lifecycle.paramEntity, desc.lifecycle.title);
                if (tabId && desc.lifecycleKey === activeKey) activeTabId = tabId;
            } else {
                tabId = this.openTab(desc.nodeId);
                if (tabId && desc.nodeId === activeKey) activeTabId = tabId;
            }
        });

        if (activeTabId) this.switchTab(activeTabId);
    }

    refreshHighlight() {
        if (!this.contentArea) return;
        const activeTab = this.tabs.find(t => t.id === this.activeTabId);
        if (!activeTab || !activeTab.contentContainer) return;
        const vizNodes = activeTab.contentContainer.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (node.style.display !== "none" && typeof node.refreshHighlight === "function") {
                node.refreshHighlight();
            }
        });
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

    relayout() {
        // Re-run the full layout on all tab visualizations. Needed when a toggle
        // that affects vertical spacing (orthogonal / edges) changes.
        if (!this.contentArea) return;
        const vizNodes = this.contentArea.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (typeof node.relayout === "function") {
                node.relayout();
            }
        });
    }

    updateEdgeThickness() {
        // Re-apply edge stroke widths on all tab visualizations
        if (!this.contentArea) return;
        const vizNodes = this.contentArea.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (typeof node.updateEdgeThickness === "function") {
                node.updateEdgeThickness();
            }
        });
    }

    updateViewportCulling() {
        // Re-run viewport culling (and edge materialisation) on all tab
        // visualizations, e.g. after the global "Edges" toggle changed.
        if (!this.contentArea) return;
        const vizNodes = this.contentArea.querySelectorAll(".viz-container");
        vizNodes.forEach(node => {
            if (node.style.display !== "none" && typeof node.updateViewportCulling === "function") {
                node.updateViewportCulling(true);
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
    btnCombined.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
        + `<path d="m12 3 9 5-9 5-9-5 9-5Z"></path><path d="m3 12 9 5 9-5"></path>`
        + `<path d="m3 16 9 5 9-5"></path></svg><span>Combined</span>`;
    btnCombined.title = "Show both Callers (above) and Callees (below)";

    const btnCallees = document.createElement("button");
    btnCallees.className = "tab-sub-btn";
    btnCallees.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
        + `<path d="M12 4v14"></path><path d="m6 12 6 6 6-6"></path></svg><span>Callees</span>`;
    btnCallees.title = "Show only functions called by this node";

    const btnCallers = document.createElement("button");
    btnCallers.className = "tab-sub-btn";
    btnCallers.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
        + `<path d="M12 20V6"></path><path d="m6 12 6-6 6 6"></path></svg><span>Callers</span>`;
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

    const subGraphOptions = {
        focusNodeId: nodeId,
        showDegreeHats: true,
        onNodeHover: (hId, activeSet) => {
            const leftViz = document.getElementById("visualization");
            if (leftViz && typeof leftViz.highlightNodeHover === "function") {
                leftViz.highlightNodeHover(hId, activeSet);
            }
        },
        onNodeMouseOut: () => {
            const leftViz = document.getElementById("visualization");
            if (leftViz && typeof leftViz.clearNodeHover === "function") {
                leftViz.clearNodeHover();
            }
        },
        onNodeClick: (cId, activeSet) => {
            if (window.detailPanelManager) {
                window.detailPanelManager.selectedNodeId = cId;
                window.detailPanelManager.selectedActiveSet = activeSet;
            }
            const leftViz = document.getElementById("visualization");
            if (leftViz && typeof leftViz.selectNode === "function") {
                leftViz.selectNode(cId, activeSet);
            }
        }
    };

    // --- 1. Build Combined Graph (Default on start) ---
    const combinedSel = d3.select(combinedViz);
    const combinedState = createGraphState();
    const combined = buildCombinedGraph(nodeId, origNodes, origEdges);

    if (combined.hasCallers || combined.hasCallees) {
        renderGraph(combined.levels, combined.depthById, combined.nodes, combined.edges, combinedSel, combinedState, subGraphOptions);
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
            renderGraph(calleeLevels, calleeDepth, cNodes, cEdges, calleeSel, calleeState, subGraphOptions);
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
            renderGraph(flipped.levels, flipped.depthById, callerNodes, flipped.edges, callerSel, callerState, subGraphOptions);
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

        if (window.detailPanelManager && window.detailPanelManager.selectedNodeId) {
            const targetViz = activeType === "combined" ? combinedViz : (activeType === "callees" ? calleeViz : callerViz);
            if (targetViz && typeof targetViz.selectNode === "function") {
                targetViz.selectNode(window.detailPanelManager.selectedNodeId, window.detailPanelManager.selectedActiveSet);
            }
        }
    }

    btnCombined.addEventListener("click", () => showSubTab("combined"));
    btnCallees.addEventListener("click", () => showSubTab("callees"));
    btnCallers.addEventListener("click", () => showSubTab("callers"));

    return { combinedState, getCalleeState: () => calleeState, getCallerState: () => callerState };
}

// ---------------------------------------------------------------------------
// Lifecycle tab
// ---------------------------------------------------------------------------

const LIFECYCLE_ROLES = [
    {
        key: "create", bit: 1, label: "Create", cls: "role-create",
        glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9L12 3Z"></path></svg>`
    },
    {
        key: "pass", bit: 8, label: "Pass", cls: "role-pass",
        glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path></svg>`
    },
    {
        key: "write", bit: 2, label: "Write", cls: "role-write",
        glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="M12 20h9"></path>`
            + `<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z"></path></svg>`
    },
    {
        key: "read", bit: 4, label: "Read", cls: "role-read",
        glyph: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path>`
            + `<circle cx="12" cy="12" r="3"></circle></svg>`
    }
];

function shortLifecycleName(text) {
    const t = String(text || "");
    const parts = t.split(/[%/]/);
    return parts.length > 1 ? parts.slice(-2).join("%") : t;
}

function lifecycleFnInfo(nodeId, nodes) {
    const raw = nodes && nodes.get(nodeId);
    const info = parseNodeLabel(raw == null ? String(nodeId) : raw);
    return {
        name: info.lines[info.lines.length - 1] || String(nodeId),
        file: info.file || "",
        folder: info.folder || ""
    };
}

function shortEntityName(entity) {
    if (!entity) return "";
    return String(entity).replace(/^(field|param|var|local|this):/, "");
}

function lifecycleEntries(trace) {
    const entities = trace.entities || [];
    const vias = trace.vias || ["assign", "expr", "allocate", "read", "copy", "call", "pass"];
    // The extractor can emit the same pass row several times for one call site.
    // Keep every raw event here; renderLifecycleTimeline groups adjacent rows
    // that look identical and shows the repeat count ("×3") instead of
    // repeating the same line over and over.
    return (trace.events || []).map(ev => ({
        fn: ev[0],
        line: ev[1],
        mask: ev[2],
        via: vias[ev[3]] || "assign",
        entity: ev[4] >= 0 ? entities[ev[4]] : "",
        otherFn: ev[5] >= 0 ? ev[5] : null,
        otherEntity: ev[6] >= 0 ? entities[ev[6]] : ""
    }));
}

function lifecycleEntryDisplay(entry, nodes) {
    const info = lifecycleFnInfo(entry.fn, nodes);
    const detail = (entry.mask & 8 && entry.otherFn !== null)
        ? `${shortEntityName(entry.entity)} -> ${shortEntityName(entry.otherEntity)} @ ${lifecycleFnInfo(entry.otherFn, nodes).name}`
        : (entry.entity ? shortEntityName(entry.entity) : "");
    return {
        info,
        detail,
        loc: `${info.file || "?"}:${entry.line || "?"}`
    };
}

function lifecycleDisplayKey(entry, nodes) {
    const display = lifecycleEntryDisplay(entry, nodes);
    return [entry.mask, display.info.name, display.loc, display.detail, entry.via].join("\u001f");
}

function groupLifecycleEntries(entries, nodes) {
    const groups = [];
    for (const entry of entries) {
        const key = lifecycleDisplayKey(entry, nodes);
        const last = groups[groups.length - 1];
        if (last && last.key === key) {
            last.count += 1;
        } else {
            groups.push({ key, count: 1, entry });
        }
    }
    return groups;
}

function centerNodeOnGraph(nodeId) {
    const container = document.getElementById("visualization");
    if (!container) return;
    // While a data trace is active the trace overlay already marks every node
    // and edge on the path. Selecting the node as well would highlight the
    // full call-graph closure and bury the data path under unrelated edges.
    // Still mark the node the user just clicked so it stands out from the
    // other trace nodes.
    const traceActive = typeof window.isDataTraceActive === "function" && window.isDataTraceActive();
    if (traceActive && typeof container.focusTraceNode === "function") {
        container.focusTraceNode(nodeId);
    }
    if (typeof container.centerNode === "function") container.centerNode(nodeId, 0.9);
    if (!traceActive && typeof container.selectNode === "function") container.selectNode(nodeId);
}

function lifecycleRow(entry, nodes, trace, count) {
    const row = document.createElement("div");
    row.className = "lifecycle-row";
    row.title = "Click to centre this function on the graph";
    row.addEventListener("click", () => centerNodeOnGraph(entry.fn));

    const glyphs = document.createElement("span");
    glyphs.className = "lifecycle-glyphs";
    for (const role of LIFECYCLE_ROLES) {
        if (entry.mask & role.bit) {
            const g = document.createElement("span");
            g.className = `lifecycle-glyph ${role.cls}`;
            g.innerHTML = role.glyph;
            g.title = role.label;
            glyphs.appendChild(g);
        }
    }
    row.appendChild(glyphs);

    const display = lifecycleEntryDisplay(entry, nodes);
    const main = document.createElement("div");
    main.className = "lifecycle-main";
    const fn = document.createElement("span");
    fn.className = "lifecycle-fn";
    fn.textContent = display.info.name;
    main.appendChild(fn);

    const loc = document.createElement("span");
    loc.className = "lifecycle-loc";
    loc.textContent = display.loc;
    main.appendChild(loc);

    if (display.detail) {
        const detail = document.createElement("span");
        detail.className = (entry.mask & 8 && entry.otherFn !== null)
            ? "lifecycle-pass"
            : "lifecycle-entity";
        detail.textContent = display.detail;
        main.appendChild(detail);
    }

    const via = document.createElement("span");
    via.className = "lifecycle-via";
    via.textContent = count > 1 ? `${entry.via} ×${count}` : entry.via;
    if (count > 1) {
        via.title = `${count} identical events`;
    }
    main.appendChild(via);
    row.appendChild(main);
    return row;
}

function renderLifecycleTimeline(host, trace, nodes) {
    const entries = lifecycleEntries(trace);
    if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "lifecycle-empty";
        empty.textContent = "This data group has no read/write/pass events.";
        host.appendChild(empty);
        return;
    }

    const groups = groupLifecycleEntries(entries, nodes);
    const heading = document.createElement("div");
    heading.className = "lifecycle-heading";
    heading.textContent = `Timeline · ${entries.length} events (approx. program order)`;
    host.appendChild(heading);

    if (groups.length <= 200) {
        // Keep the events in their recorded order. Grouping by role turned
        // "create, pass, read, pass, read…" into separate create/pass/read
        // sections and hid the actual sequence of uses.
        const list = document.createElement("div");
        list.className = "lifecycle-list";
        groups.forEach(group => {
            list.appendChild(lifecycleRow(group.entry, nodes, trace, group.count));
        });
        host.appendChild(list);
        return;
    }

    // Larger traces: windowed list (only the visible ~60 rows exist in the DOM).
    const viewport = document.createElement("div");
    viewport.className = "lifecycle-virtual";
    const sizer = document.createElement("div");
    sizer.className = "lifecycle-virtual-sizer";
    const inner = document.createElement("div");
    inner.className = "lifecycle-virtual-inner";
    const ROW_HEIGHT = 38;
    sizer.style.height = `${groups.length * ROW_HEIGHT}px`;
    sizer.appendChild(inner);
    viewport.appendChild(sizer);
    host.appendChild(viewport);

    let start = -1;
    const draw = () => {
        const height = viewport.clientHeight || 480;
        const visible = Math.ceil(height / ROW_HEIGHT) + 12;
        const nextStart = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 4);
        if (nextStart === start) return;
        start = nextStart;
        inner.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
        inner.innerHTML = "";
        groups.slice(start, start + visible).forEach(group => {
            inner.appendChild(lifecycleRow(group.entry, nodes, trace, group.count));
        });
    };
    viewport.addEventListener("scroll", draw);
    requestAnimationFrame(draw);
    setTimeout(draw, 40);
}

function renderLifecycleInContainer(trace, view, paramEntity, container, nodes) {
    container.innerHTML = "";

    const start = document.createElement("div");
    start.className = "lifecycle-start";
    let origin = trace.origin || {};
    if (view && view.mode === "backward" && view.originFn !== undefined) {
        const info = lifecycleFnInfo(view.originFn, nodes);
        origin = {
            node: view.originFn,
            name: info.name,
            file: view.originFile || origin.file,
            line: view.originLine || origin.line
        };
    }
    const createdHere = !!(view && view.originCreated);
    const eventCount = (view && view.counts && Number.isFinite(view.counts.events))
        ? view.counts.events
        : (trace.events || []).length;
    const noEvents = !createdHere && eventCount === 0;
    const here = document.createElement("div");
    here.className = "lifecycle-start-title"
        + (createdHere ? "" : noEvents ? " is-no-path" : " is-first-use");
    const startIcon = createdHere
        ? `<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.4l6.1-.9L12 3Z"></path>`
        : noEvents
            ? `<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>`
            : `<path d="M5 21V4"></path><path d="M5 4h10l-2 4 2 4H5"></path>`;
    here.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
        + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
        + startIcon + `</svg>`
        + `<span>${createdHere ? "Created here" : noEvents ? "No recorded path" : "First known use"}</span>`;
    start.appendChild(here);

    const fnLine = document.createElement("div");
    fnLine.className = "lifecycle-start-fn";
    fnLine.textContent = origin.name || "unknown origin";
    start.appendChild(fnLine);

    const fileLine = document.createElement("div");
    fileLine.className = "lifecycle-start-file";
    const fileText = origin.file ? `${origin.file}:${origin.line || "?"}` : "(no file)";
    fileLine.textContent = fileText;
    fileLine.title = fileText;
    start.appendChild(fileLine);

    if (!createdHere) {
        const note = document.createElement("div");
        note.className = "lifecycle-note";
        const createCount = (view && view.counts ? view.counts.create : 0) || 0;
        if (noEvents) {
            note.textContent = "No read, write or pass event was recorded for this entity. "
                + "For a parameter this usually means it was only declared and passed in; "
                + "the extractor could not attribute a use to it.";
        } else {
            note.textContent = createCount > 0
                ? "The trace does not start at a create event; an earlier creation may be outside the analysed code."
                : "No create or write event is recorded for this entity. This is the earliest known use — usually a function argument or a value passed in by the caller.";
        }
        start.appendChild(note);
    }

    const actions = document.createElement("div");
    actions.className = "lifecycle-start-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "lifecycle-copy";
    copy.textContent = "Copy path";
    copy.addEventListener("click", () => {
        const text = origin.file ? `${origin.file}:${origin.line || ""}` : "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                copy.textContent = "Copied";
                setTimeout(() => { copy.textContent = "Copy path"; }, 1200);
            }).catch(() => {});
        }
    });
    actions.appendChild(copy);

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "lifecycle-copy";
    jump.textContent = createdHere ? "Jump to origin" : noEvents ? "Jump to declaration" : "Jump to first use";
    jump.addEventListener("click", () => {
        if (origin.node !== undefined) centerNodeOnGraph(origin.node);
    });
    actions.appendChild(jump);
    start.appendChild(actions);

    if (paramEntity) {
        const paramLine = document.createElement("div");
        paramLine.className = "lifecycle-param";
        paramLine.textContent = `parameter ${shortEntityName(paramEntity)} · ${view.mode} mode`;
        start.appendChild(paramLine);
    }
    container.appendChild(start);

    const body = document.createElement("div");
    body.className = "lifecycle-body";
    container.appendChild(body);
    renderLifecycleTimeline(body, trace, nodes);
}

window.DetailPanelManager = DetailPanelManager;
window.renderSubGraphInContainer = renderSubGraphInContainer;
window.renderLifecycleInContainer = renderLifecycleInContainer;
