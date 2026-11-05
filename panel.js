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
        this.initStructKeys();
    }

    initStructKeys() {
        document.addEventListener("keydown", (e) => {
            const tab = this.tabs.find(t => t.id === this.activeTabId);
            if (!tab || tab.type !== "struct" || !tab.explorer) return;
            const target = e.target;
            if (target && /input|textarea|select/i.test(target.tagName || "")) return;
            if (e.altKey && e.key === "ArrowLeft") {
                e.preventDefault();
                tab.explorer.back();
            } else if (e.altKey && e.key === "ArrowRight") {
                e.preventDefault();
                tab.explorer.forward();
            } else if (e.key === "Backspace") {
                e.preventDefault();
                tab.explorer.up();
            }
        });
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
            // A parameter card opened from a side tab is bounded by the graph
            // pane, so its position has to follow the splitter.
            if (typeof window.updateOverlayPositions === "function") {
                window.updateOverlayPositions();
            }
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

        // Opening a tab focuses its node in the side graph as well, instead of
        // carrying over the selection made in the previously active tab.
        this.selectedNodeId = nodeId;
        this.selectedActiveSet = null;
        this.selectNode(this.selectedNodeId, this.selectedActiveSet);

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

    /**
     * Open (or focus) the struct & variable explorer. A single explorer tab is
     * reused so search, parameter cards and graph menus all navigate the same
     * navigation stack.
     */
    openStruct(initialNode, options) {
        if (typeof window.closeParamCard === "function") window.closeParamCard();
        const existing = this.tabs.find(t => t.type === "struct");
        if (existing) {
            this.switchTab(existing.id);
            if (existing.explorer) {
                if (options && options.fnNode !== undefined) {
                    existing.explorer.options.fnNode = options.fnNode;
                    existing.explorer.options.fnName = options.fnName || "";
                    existing.explorer.options.holder = options.holder ?? null;
                } else if (initialNode) {
                    // A fresh entry point (search, lifecycle link, graph menu)
                    // is not scoped to whatever function the tab was opened from.
                    existing.explorer.options.fnNode = null;
                    existing.explorer.options.fnName = "";
                    existing.explorer.options.holder = null;
                }
                if (initialNode) existing.explorer.push(initialNode);
            }
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

        const tabBtn = document.createElement("div");
        tabBtn.className = "detail-tab";
        tabBtn.title = "Struct explorer";
        tabBtn.dataset.tabId = tabId;
        const kindIcon = document.createElement("span");
        kindIcon.className = "tab-kind-icon";
        kindIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" `
            + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
            + `<rect x="3" y="3" width="7" height="7" rx="1"></rect>`
            + `<rect x="14" y="3" width="7" height="7" rx="1"></rect>`
            + `<rect x="3" y="14" width="7" height="7" rx="1"></rect>`
            + `<rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>`;
        const titleSpan = document.createElement("span");
        titleSpan.className = "detail-tab-title";
        titleSpan.textContent = "Struct";
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
        contentContainer.className = "tab-content-container struct-content";
        contentContainer.dataset.tabId = tabId;
        contentContainer.style.display = "flex";
        this.contentArea.appendChild(contentContainer);

        const tabObj = {
            id: tabId,
            nodeId: null,
            type: "struct",
            displayName: "Struct",
            fullTitle: "Struct explorer",
            tabBtn,
            titleSpan,
            contentContainer,
            structState: null
        };
        tabObj.explorer = new StructExplorer(this, tabObj, contentContainer,
            initialNode || null, options || {});
        this.tabs.push(tabObj);
        this.activeTabId = tabId;
        this.notifyActiveNodeChanged(null);
        tabBtn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        tabObj.explorer.start();
        return tabId;
    }

    setStructTabTitle(tab, label) {
        if (!tab) return;
        const text = String(label || "Struct");
        tab.displayName = text;
        tab.fullTitle = `Struct · ${text}`;
        if (tab.titleSpan) tab.titleSpan.textContent = text;
        if (tab.tabBtn) tab.tabBtn.title = `Struct · ${text}`;
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

        // A parameter card anchored to another side tab would be left floating
        // over an unrelated graph after the switch.
        if (window.isParamCardAnchoredTo && window.isParamCardAnchoredTo(this.detailPanel) &&
            !window.isParamCardAnchoredTo(tab.contentContainer)) {
            window.closeParamCard();
        }

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

        // Switching tabs moves the focus to that tab's node in both views.
        if (tab.nodeId !== null && tab.nodeId !== undefined) {
            this.selectedNodeId = tab.nodeId;
            this.selectedActiveSet = null;
        }
        if (this.selectedNodeId) {
            this.selectNode(this.selectedNodeId, this.selectedActiveSet);
        }
    }

    closeTab(tabId) {
        const index = this.tabs.findIndex(t => t.id === tabId);
        if (index === -1) return;

        const tab = this.tabs[index];

        // Close a parameter card that belongs to this tab before its graph is
        // removed from the DOM.
        if (window.isParamCardAnchoredTo && window.isParamCardAnchoredTo(tab.contentContainer)) {
            window.closeParamCard();
        }

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
        if (window.isParamCardAnchoredTo && window.isParamCardAnchoredTo(this.detailPanel)) {
            window.closeParamCard();
        }
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
            lifecycleKey: t.lifecycleKey || null,
            structState: t.structState || null
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
            } else if (desc.type === "struct" && desc.structState) {
                const st = desc.structState;
                const node = st.stack[st.index] || null;
                tabId = this.openStruct(node, st.state || {});
                const reopened = this.tabs.find(t => t.id === tabId);
                if (reopened && reopened.explorer && st.stack.length) {
                    reopened.explorer.stack = st.stack.slice();
                    reopened.explorer.index = st.index;
                    Object.assign(reopened.explorer.state, st.state || {});
                    reopened.explorer.syncTabState();
                    reopened.explorer.render();
                }
                if (tabId && desc.type === activeTab?.type) activeTabId = tabId;
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
            if (!leftViz) return;
            // A data trace owns the main view's colours. Selecting the node
            // would be ignored there, so move the trace focus instead and
            // bring the node into view.
            const traceActive = typeof window.isDataTraceActive === "function" && window.isDataTraceActive();
            if (traceActive && typeof leftViz.focusTraceNode === "function") {
                leftViz.focusTraceNode(cId || null);
                if (cId && typeof leftViz.centerNode === "function") {
                    leftViz.centerNode(cId, 0.9);
                }
                return;
            }
            if (typeof leftViz.selectNode === "function") {
                leftViz.selectNode(cId, activeSet);
            }
            if (cId && typeof leftViz.centerNode === "function") {
                leftViz.centerNode(cId, 0.9);
            }
        }
    };

    // A parameter card opened from this tab follows the tab's pan/zoom.
    const syncOverlayPositions = () => {
        if (typeof window.updateOverlayPositions === "function") {
            window.updateOverlayPositions();
        }
    };

    // --- 1. Build Combined Graph (Default on start) ---
    const combinedSel = d3.select(combinedViz);
    const combinedState = createGraphState();
    combinedState.onTransform = syncOverlayPositions;
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
        calleeState.onTransform = syncOverlayPositions;
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
        callerState.onTransform = syncOverlayPositions;
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
        const isPass = entry.mask & 8 && entry.otherFn !== null;
        if (!isPass && entry.entity && /^(field|param|var|local):/.test(entry.entity)) {
            detail.classList.add("lifecycle-link");
            detail.title = "Open in the struct explorer";
            detail.addEventListener("click", (e) => {
                e.stopPropagation();
                if (typeof window.openStructEntity === "function") {
                    window.openStructEntity(entry.entity);
                }
            });
        }
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
window.renderLifecycleTimeline = renderLifecycleTimeline;
window.centerNodeOnGraph = centerNodeOnGraph;
window.centerGraphNode = centerNodeOnGraph;


// ---------------------------------------------------------------------------
// Struct & variable explorer tab
// ---------------------------------------------------------------------------

function structBaseTypeName(type) {
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

function structRankSuffix(rank) {
    const n = Number(rank) || 0;
    return n ? `(${Array(n).fill(":").join(",")})` : "";
}

function structEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function structEntityKind(entity) {
    const text = String(entity || "");
    const i = text.indexOf(":");
    return i >= 0 ? text.slice(0, i) : "";
}

class StructExplorer {
    constructor(manager, tab, host, initialNode, options) {
        this.manager = manager;
        this.tab = tab;
        this.host = host;
        this.initialNode = initialNode || null;
        this.options = options || {};
        this.data = null;
        this.stack = [];
        this.index = -1;
        this.state = {
            sort: "usage",
            hideUnused: false,
            showInherited: true,
            routeMode: "all",
            holder: this.options.holder || null,
            fnNode: this.options.fnNode ?? null,
            fnName: this.options.fnName || ""
        };
        this.touchCache = new Map();
        this.traceCache = new Map();
        this.renderToken = 0;
    }

    async start() {
        this.host.innerHTML = "";
        this.host.appendChild(structEl("div", "struct-empty", "Loading struct data…"));
        const client = window.dataflowClient;
        const data = client ? await client.getStructs() : null;
        if (!data || !data.types) {
            this.host.innerHTML = "";
            this.host.appendChild(structEl("div", "struct-empty",
                "Struct data is not available. Rebuild vis/ with the structured exporter."));
            return;
        }
        this.data = data;
        if (this.stack.length && this.index >= 0) {
            // A refresh (hidden folders/files) restored the navigation stack
            // before the data finished loading.
            this.render();
            return;
        }
        let node = this.initialNode;
        if (!node) {
            const first = Object.keys(data.types)[0];
            node = first ? { kind: "type", typeKey: first } : null;
        }
        if (node) this.push(node, { replace: true });
        else this.render();
    }

    syncTabState() {
        this.tab.structState = {
            stack: this.stack.slice(),
            index: this.index,
            state: { ...this.state }
        };
    }

    push(node, opts) {
        if (!node) return;
        this._filter = "";
        if (node.kind === "member" && !node.route) {
            // Pre-fill the breadcrumb from the member's most frequent route.
            // A struct member without its own lifecycle group has only
            // aggregated child routes; those must not become its route.
            const field = this.fieldOf(node.member);
            const routes = this.memberRoutes(node.member);
            if (field && field.gid && routes.length) {
                node = { ...node, route: routes[0][0], routeMode: "route" };
            }
        }
        const current = this.stack[this.index];
        const sameNode = current && current.kind === node.kind
            && current.typeKey === node.typeKey
            && current.member === node.member
            && current.fnNode === node.fnNode;
        if (opts && opts.replace) {
            this.stack[this.index] = node;
        } else if (sameNode && current.route === node.route) {
            this.stack[this.index] = node;
        } else {
            this.stack = this.stack.slice(0, this.index + 1);
            this.stack.push(node);
            this.index = this.stack.length - 1;
        }
        // A new node resets route/function scope unless it carries its own.
        this.state.routeMode = node.routeMode || (node.route ? "route" : "all");
        if (!node.keepFn) {
            if (node.fnNode === undefined) this.state.fnNode = this.options.fnNode ?? null;
            if (node.fnName === undefined) this.state.fnName = this.options.fnName || "";
        } else {
            this.state.fnNode = node.fnNode ?? this.state.fnNode;
            this.state.fnName = node.fnName || this.state.fnName;
        }
        this.state.holder = node.holderId || node.holder || null;
        if (!this.state.holder && node.kind === "type" && this.options.holder) {
            this.state.holder = this.options.holder;
        }
        this.syncTabState();
        this.render();
    }

    back() {
        if (this.index <= 0) return;
        this.index -= 1;
        this.syncTabState();
        this.render();
    }

    forward() {
        if (this.index >= this.stack.length - 1) return;
        this.index += 1;
        this.syncTabState();
        this.render();
    }

    up() {
        const node = this.node();
        if (!node) return;
        if (node.kind === "type" && !node.route) return;
        const crumbs = this.crumbs(node);
        if (crumbs.length > 1 && crumbs[crumbs.length - 2].node) {
            this.push(crumbs[crumbs.length - 2].node);
        }
    }

    node() {
        return this.stack[this.index] || null;
    }

    typeOf(key) {
        return this.data && key ? (this.data.types[key] || null) : null;
    }

    fieldOf(member) {
        if (!member) return null;
        const typeKey = member.split("%")[0];
        const name = member.split("%").pop();
        const rec = this.typeOf(typeKey);
        if (!rec) return null;
        return (rec.fields || []).find((f) => f.name === name && f.member === member) || null;
    }

    memberRoutes(member) {
        const typeKey = (member || "").split("%")[0];
        const rec = this.typeOf(typeKey);
        return (rec && rec.routes && rec.routes[member]) || [];
    }

    memberUsage(member, scopePrefix) {
        let routes = this.memberRoutes(member);
        if (scopePrefix) {
            routes = routes.filter((route) => route[0] === scopePrefix
                || route[0].startsWith(scopePrefix + "%"));
        }
        let read = 0, write = 0, create = 0, fns = 0;
        for (const route of routes) {
            read += route[1] || 0;
            write += route[2] || 0;
            create += route[3] || 0;
            fns = Math.max(fns, route[4] || 0);
        }
        return { read, write, create, fns };
    }

    async loadTouch(typeKey) {
        if (!typeKey) return null;
        if (this.touchCache.has(typeKey)) return this.touchCache.get(typeKey);
        const client = window.dataflowClient;
        const touch = client ? await client.getStructTouch(typeKey) : null;
        this.touchCache.set(typeKey, touch);
        return touch;
    }

    async loadTrace(gid) {
        if (!gid) return null;
        if (this.traceCache.has(gid)) return this.traceCache.get(gid);
        const client = window.dataflowClient;
        const trace = client ? await client.getTrace(gid) : null;
        this.traceCache.set(gid, trace);
        return trace;
    }

    // --- breadcrumb -------------------------------------------------------
    routeCrumbs(route, leafNode) {
        const parts = String(route || "").split("%").filter(Boolean);
        if (!parts.length) return [];
        const root = parts[0];
        const out = [{ label: root, node: { kind: "type", typeKey: root } }];
        let owner = root;
        for (let i = 1; i < parts.length; i += 1) {
            const rec = this.typeOf(owner);
            const field = rec && (rec.fields || []).find((f) => f.name === parts[i]);
            if (!field) break;
            const isLast = i === parts.length - 1;
            const prefix = parts.slice(0, i + 1).join("%");
            let crumbNode;
            if (leafNode && leafNode.member === field.member) {
                crumbNode = leafNode;
            } else {
                crumbNode = {
                    kind: "member", member: field.member, typeKey: field.owner,
                    route: isLast ? route : prefix,
                };
            }
            out.push({ label: parts[i], node: crumbNode });
            if (field.value && !isLast) {
                out.push({ label: parts.slice(i + 1).join("%"), node: null });
                break;
            }
            owner = structBaseTypeName(field.type);
        }
        return out;
    }

    crumbs(node) {
        if (!node) return [];
        if (node.kind === "type") {
            if (node.route) {
                const out = this.routeCrumbs(node.route, null);
                out.push({
                    label: node.typeKey,
                    node: { kind: "type", typeKey: node.typeKey, route: node.route },
                });
                return out;
            }
            return [{ label: node.typeKey, node: { kind: "type", typeKey: node.typeKey } }];
        }
        if (node.kind === "variable") {
            const out = [];
            const rec = this.typeOf(node.typeKey);
            if (rec) out.push({ label: rec.name, node: { kind: "type", typeKey: node.typeKey } });
            out.push({ label: node.name || "variable", node });
            return out;
        }
        if (node.kind === "function") {
            return [{ label: node.name || "function", node }];
        }
        // member
        const member = node.member || "";
        const route = node.route || member;
        const out = this.routeCrumbs(route, node);
        if (out.length <= 1) {
            out.push({ label: member.split("%").pop(), node });
        }
        return out;
    }

    // --- rendering --------------------------------------------------------
    async render() {
        if (!this.data) return;
        const node = this.node();
        this.renderToken += 1;
        const token = this.renderToken;
        this.host.innerHTML = "";

        const toolbar = structEl("div", "struct-toolbar");
        const nav = structEl("div", "struct-nav");
        const back = structEl("button", "struct-icon-btn", "◀");
        back.type = "button";
        back.title = "Back (Alt+←)";
        back.disabled = this.index <= 0;
        back.addEventListener("click", () => this.back());
        const fwd = structEl("button", "struct-icon-btn", "▶");
        fwd.type = "button";
        fwd.title = "Forward (Alt+→)";
        fwd.disabled = this.index >= this.stack.length - 1;
        fwd.addEventListener("click", () => this.forward());
        nav.appendChild(back);
        nav.appendChild(fwd);

        const crumbs = structEl("div", "struct-crumbs");
        for (const crumb of this.crumbs(node)) {
            if (crumb.node) {
                const b = structEl("button", "struct-crumb", crumb.label);
                b.type = "button";
                b.title = crumb.label;
                b.addEventListener("click", () => this.push(crumb.node));
                crumbs.appendChild(b);
            } else {
                const span = structEl("span", "struct-crumb is-facet", crumb.label);
                span.title = "value-type sub-component";
                crumbs.appendChild(span);
            }
            const sep = structEl("span", "struct-crumb-sep", "›");
            crumbs.appendChild(sep);
        }
        toolbar.appendChild(nav);
        toolbar.appendChild(crumbs);

        if (node && node.kind === "member") {
            const scope = structEl("select", "struct-scope");
            const all = structEl("option", null, "All routes");
            all.value = "all";
            const one = structEl("option", null, "This route");
            one.value = "route";
            scope.appendChild(all);
            scope.appendChild(one);
            scope.value = this.state.routeMode;
            scope.disabled = !node.route;
            scope.title = "Count all routes or only the route in the breadcrumb";
            scope.addEventListener("change", () => {
                this.state.routeMode = scope.value;
                this.render();
            });
            toolbar.appendChild(scope);
        }

        const graphBtn = structEl("button", "struct-action", "Show on graph");
        graphBtn.type = "button";
        graphBtn.title = "Highlight the functions that touch this data";
        graphBtn.addEventListener("click", () => this.showOnGraph());
        toolbar.appendChild(graphBtn);
        this.host.appendChild(toolbar);

        const body = structEl("div", "struct-body");
        this.host.appendChild(body);

        if (!node) {
            body.appendChild(structEl("div", "struct-empty", "Nothing selected."));
            return;
        }
        let label = node.typeKey || node.member || node.name || "Struct";
        if (node.kind === "type") label = node.typeKey;
        else if (node.kind === "member") label = (node.member || "").split("%").pop();
        else if (node.kind === "variable") label = node.name || "variable";
        else if (node.kind === "function") label = node.name || "function";
        this.manager.setStructTabTitle(this.tab, label);

        if (node.kind === "type") this.renderType(body, node, token);
        else if (node.kind === "member") await this.renderMember(body, node, token);
        else if (node.kind === "variable") await this.renderVariable(body, node, token);
        else if (node.kind === "function") await this.renderFunction(body, node, token);
    }

    renderType(body, node, token) {
        const rec = this.typeOf(node.typeKey);
        if (!rec) {
            body.appendChild(structEl("div", "struct-empty", "Type not found."));
            return;
        }
        const header = structEl("div", "struct-header");
        const title = structEl("div", "struct-title");
        title.appendChild(structEl("span", "struct-title-name", rec.name));
        if (rec.value) {
            const badge = structEl("span", "struct-badge", "value type");
            badge.title = "Tiny value type: its components are folded into the parent member";
            title.appendChild(badge);
        }
        header.appendChild(title);

        const meta = structEl("div", "struct-meta");
        const loc = rec.file ? `${rec.file}${rec.line ? ":" + rec.line : ""}` : "location not recorded";
        meta.appendChild(structEl("span", "struct-module", rec.module || "—"));
        meta.appendChild(structEl("span", "struct-dot", "·"));
        meta.appendChild(structEl("span", "struct-loc", loc));
        if (rec.extends) {
            meta.appendChild(structEl("span", "struct-dot", "·"));
            const ext = structEl("button", "struct-link", `extends ${rec.extends}`);
            ext.type = "button";
            ext.addEventListener("click", () => this.push({ kind: "type", typeKey: rec.extends }));
            meta.appendChild(ext);
        }
        header.appendChild(meta);

        const counts = rec.counts || {};
        const stats = structEl("div", "struct-stats");
        stats.textContent = `${counts.create || 0} create · ${counts.write || 0} write · `
            + `${counts.read || 0} read · ${counts.functions || 0} fn`;
        header.appendChild(stats);
        body.appendChild(header);

        // Known as / contained in chips.
        if ((rec.holders || []).length) {
            const row = structEl("div", "struct-chip-row");
            row.appendChild(structEl("span", "struct-chip-label", "Known as"));
            (rec.holders || []).slice(0, 20).forEach((holder) => {
                const chip = structEl("button", "struct-chip",
                    `${holder.name}${holder.count ? ` · ${holder.count} fn` : ""}`);
                chip.type = "button";
                chip.title = `${holder.kind}${holder.scope ? " · " + holder.scope : ""}`;
                if (this.state.holder
                    && (this.state.holder === holder.id || this.state.holder === holder.name)) {
                    chip.classList.add("active");
                }
                chip.addEventListener("click", () => this.openHolder(holder, node.typeKey));
                row.appendChild(chip);
            });
            body.appendChild(row);
        }
        if (this.state.holder) {
            const holder = (rec.holders || []).find((h) => h.id === this.state.holder)
                || (rec.holders || []).find((h) => h.name === this.state.holder);
            if (holder) {
                const notice = structEl("div", "struct-notice struct-holder-notice");
                notice.appendChild(structEl("span", null,
                    `Pinned: ${holder.name} · ${holder.kind}`
                    + (holder.scope ? ` · ${holder.scope}` : "")));
                const traceBtn = structEl("button", "struct-action", "Trace variable");
                traceBtn.type = "button";
                traceBtn.addEventListener("click", async () => {
                    const gid = await this.findGroupForEntity(holder.id);
                    if (gid && typeof window.startTrace === "function") {
                        window.startTrace(gid, "full", null, holder.name);
                    } else {
                        window.showToast && window.showToast("No lifecycle group for this variable.");
                    }
                });
                notice.appendChild(traceBtn);
                body.appendChild(notice);
            }
        }
        if ((rec.parents || []).length) {
            const row = structEl("div", "struct-chip-row");
            row.appendChild(structEl("span", "struct-chip-label", "Contained in"));
            (rec.parents || []).slice(0, 20).forEach(([parent, memberName]) => {
                const chip = structEl("button", "struct-chip", `${parent}%${memberName}`);
                chip.type = "button";
                chip.addEventListener("click", () => this.push({ kind: "type", typeKey: parent }));
                row.appendChild(chip);
            });
            body.appendChild(row);
        }

        if (this.state.fnNode !== null && this.state.fnNode !== undefined) {
            const notice = structEl("div", "struct-notice");
            notice.textContent = `Scoped to ${this.state.fnName || "this function"} · `
                + "members it does not touch are dimmed";
            body.appendChild(notice);
            // Load the type touch shard once and re-render with the
            // "used here" column.
            if (this._touchType !== node.typeKey) {
                this.loadTouch(node.typeKey).then((touch) => {
                    if (this.renderToken === token && touch) {
                        this._touch = touch;
                        this._touchType = node.typeKey;
                        this.render();
                    }
                });
            }
        }

        const controls = structEl("div", "struct-controls");
        const filter = structEl("input", "struct-filter");
        filter.type = "search";
        filter.placeholder = "Filter members…";
        filter.addEventListener("input", () => {
            this._filter = filter.value;
            this.renderMemberList(list, rec, node, token);
        });
        controls.appendChild(filter);

        const inherited = structEl("label", "struct-check");
        const inheritedBox = document.createElement("input");
        inheritedBox.type = "checkbox";
        inheritedBox.checked = this.state.showInherited;
        inheritedBox.addEventListener("change", () => {
            this.state.showInherited = inheritedBox.checked;
            this.render();
        });
        inherited.appendChild(inheritedBox);
        inherited.appendChild(document.createTextNode(" inherited"));
        controls.appendChild(inherited);

        const hideUnused = structEl("label", "struct-check");
        const unusedBox = document.createElement("input");
        unusedBox.type = "checkbox";
        unusedBox.checked = this.state.hideUnused;
        unusedBox.addEventListener("change", () => {
            this.state.hideUnused = unusedBox.checked;
            this.render();
        });
        hideUnused.appendChild(unusedBox);
        hideUnused.appendChild(document.createTextNode(" hide unused"));
        controls.appendChild(hideUnused);

        const sort = structEl("select", "struct-sort");
        for (const [value, text] of [["usage", "sort: usage"], ["declaration", "sort: declaration"], ["name", "sort: name"]]) {
            const o = structEl("option", null, text);
            o.value = value;
            sort.appendChild(o);
        }
        sort.value = this.state.sort;
        sort.addEventListener("change", () => {
            this.state.sort = sort.value;
            this.render();
        });
        controls.appendChild(sort);
        body.appendChild(controls);

        const list = structEl("div", "struct-member-list");
        body.appendChild(list);
        this.renderMemberList(list, rec, node, token);

        // Unresolved paths keep their raw spelling. They are listed under the
        // root type they were spelled from.
        const unresolved = (this.data.unresolved || []).filter(
            (entry) => entry.route.split("%")[0] === node.typeKey);
        if (unresolved.length) {
            const section = structEl("div", "struct-section");
            section.appendChild(structEl("div", "struct-section-title",
                `Unresolved · ${unresolved.length}`));
            const table = structEl("div", "struct-route-table");
            for (const entry of unresolved.slice(0, 40)) {
                const row = structEl("button", "struct-route-row");
                row.type = "button";
                row.title = "Keep the raw spelling; open its lifecycle if one was recorded";
                row.appendChild(structEl("span", "struct-route-name", entry.route));
                row.appendChild(structEl("span", "struct-route-counts",
                    `${entry.reads} / ${entry.writes} / ${entry.functions}`));
                row.addEventListener("click", () => {
                    if (typeof window.startTrace === "function") {
                        window.startTrace(entry.gid, "full", null, entry.route);
                    }
                });
                table.appendChild(row);
            }
            section.appendChild(table);
            body.appendChild(section);
        }
    }

    fieldTouchUsed(field) {
        if (this.state.fnNode === null || this.state.fnNode === undefined) return null;
        const touch = this._touch;
        if (!touch || !touch.members || this._touchType !== field.owner) return null;
        const member = touch.members[field.member];
        if (!member) return false;
        return (member.fn || []).some((entry) => entry[0] === this.state.fnNode);
    }

    renderMemberList(list, rec, node, token) {
        list.innerHTML = "";
        const scopePrefix = node.route || null;
        let fields = (rec.fields || []).slice();
        if (!this.state.showInherited) fields = fields.filter((f) => !f.inheritedFrom);
        if (this.state.hideUnused) {
            fields = fields.filter((f) => {
                const usage = this.memberUsage(f.member, scopePrefix);
                return usage.read + usage.write + usage.create > 0 || f.gid;
            });
        }
        const query = (this._filter || "").toLowerCase().trim();
        if (query) fields = fields.filter((f) => f.name.includes(query) || f.type.includes(query));
        const sort = this.state.sort;
        fields.sort((a, b) => {
            if (sort === "name") return a.name.localeCompare(b.name);
            if (sort === "declaration") return (a.line || 0) - (b.line || 0) || a.name.localeCompare(b.name);
            const ua = this.memberUsage(a.member, scopePrefix);
            const ub = this.memberUsage(b.member, scopePrefix);
            return (ub.read + ub.write + ub.create) - (ua.read + ua.write + ua.create)
                || a.name.localeCompare(b.name);
        });
        if (!fields.length) {
            list.appendChild(structEl("div", "struct-empty", "No members match."));
            return;
        }
        let maxUsage = 1;
        const usageById = new Map();
        for (const field of fields) {
            const usage = this.memberUsage(field.member, scopePrefix);
            usageById.set(field.member, usage);
            maxUsage = Math.max(maxUsage, usage.read + usage.write + usage.create);
        }
        for (const field of fields) {
            const usage = usageById.get(field.member);
            const total = usage.read + usage.write + usage.create;
            const used = this.fieldTouchUsed(field);
            const row = structEl("div", "struct-member-row"
                + (used === false ? " is-dim" : ""));
            const name = structEl("button", "struct-member-name", field.name);
            name.type = "button";
            name.title = field.member;
            name.addEventListener("click", () => this.openMember(field, scopePrefix));
            row.appendChild(name);

            const typeCell = structEl("span", "struct-member-type",
                `${field.type || "?"}${structRankSuffix(field.rank)}`);
            if (field.flags && field.flags.length) {
                typeCell.title = field.flags.join(", ");
                typeCell.textContent += " " + field.flags.map((f) => f[0].toUpperCase()).join("");
            }
            row.appendChild(typeCell);

            if (field.inheritedFrom) {
                const inh = structEl("span", "struct-inherited", "inherited");
                inh.title = `declared by ${field.inheritedFrom}`;
                row.appendChild(inh);
            }
            if (used !== null) {
                const here = structEl("span", "struct-used" + (used ? " is-used" : ""), used ? "here" : "—");
                here.title = used ? "used in the scoped function" : "not used in the scoped function";
                row.appendChild(here);
            }

            const bar = structEl("span", "struct-usage-bar");
            const fill = structEl("span", "struct-usage-fill");
            fill.style.width = `${Math.max(2, Math.round((total / maxUsage) * 100))}%`;
            bar.appendChild(fill);
            row.appendChild(bar);

            const nums = structEl("span", "struct-member-counts");
            nums.innerHTML = `<span title="create">C ${usage.create}</span>`
                + `<span title="write">W ${usage.write}</span>`
                + `<span title="read">R ${usage.read}</span>`
                + `<span title="functions">${usage.fns} fn</span>`;
            row.appendChild(nums);

            if (field.gid) {
                const peek = structEl("button", "struct-icon-btn", "▸");
                peek.type = "button";
                peek.title = "Peek routes";
                peek.addEventListener("click", () => this.togglePeek(row, field));
                row.appendChild(peek);
            }
            const child = structBaseTypeName(field.type);
            const childRec = this.typeOf(child);
            if (childRec && !field.value) {
                const drill = structEl("button", "struct-icon-btn", "→");
                drill.type = "button";
                drill.title = `Open ${child}`;
                drill.addEventListener("click", () => this.push({
                    kind: "type",
                    typeKey: child,
                    route: `${node.route || node.typeKey}%${field.name}`,
                }));
                row.appendChild(drill);
            } else {
                const drill = structEl("button", "struct-icon-btn", "→");
                drill.type = "button";
                drill.title = "Open member";
                drill.addEventListener("click", () => this.openMember(field, scopePrefix));
                row.appendChild(drill);
            }
            list.appendChild(row);
        }
    }

    togglePeek(row, field) {
        const next = row.nextElementSibling;
        if (next && next.classList && next.classList.contains("struct-peek")) {
            next.remove();
            return;
        }
        const routes = this.memberRoutes(field.member);
        const peek = structEl("div", "struct-peek");
        if (!routes.length) {
            peek.textContent = "No recorded route.";
        } else {
            peek.appendChild(this.routeTable(routes, (route) => {
                this.push({
                    kind: "member", member: field.member, typeKey: field.owner,
                    route, routeMode: "route",
                });
            }));
        }
        row.after(peek);
    }

    routeTable(routes, onPick) {
        const table = structEl("div", "struct-route-table");
        const head = structEl("div", "struct-route-row is-head");
        head.appendChild(structEl("span", "struct-route-name", "Route"));
        head.appendChild(structEl("span", "struct-route-counts", "C / W / R / fn"));
        table.appendChild(head);
        for (const route of routes) {
            const row = structEl("button", "struct-route-row");
            row.type = "button";
            row.title = "Use this route as the scope";
            row.appendChild(structEl("span", "struct-route-name", route[0]));
            row.appendChild(structEl("span", "struct-route-counts",
                `${route[3]} / ${route[2]} / ${route[1]} / ${route[4]}`));
            row.addEventListener("click", () => onPick(route));
            table.appendChild(row);
        }
        return table;
    }

    openMember(field, scopePrefix) {
        // Only an intrinsic/value member with its own lifecycle group gets a
        // route scope. A struct member without a group has aggregated child
        // routes, which are shown in its route table but are not its route.
        let routes = field.gid ? this.memberRoutes(field.member) : [];
        if (scopePrefix) {
            const scoped = routes.filter((route) => route[0] === scopePrefix
                || route[0].startsWith(scopePrefix + "%"));
            if (scoped.length) routes = scoped;
        }
        const route = routes.length ? routes[0][0] : null;
        this.push({
            kind: "member", member: field.member, typeKey: field.owner,
            route, routeMode: route ? "route" : "all",
        });
    }

    openHolder(holder, typeKey) {
        // Holders carry their entity id; ask the client for the trace group.
        this.push({ kind: "variable", entity: holder.id, name: holder.name,
            typeKey, gid: null, holderId: holder.id });
    }

    async renderMember(body, node, token) {
        const field = this.fieldOf(node.member);
        const rec = this.typeOf(node.typeKey);
        const header = structEl("div", "struct-header");
        const title = structEl("div", "struct-title");
        title.appendChild(structEl("span", "struct-title-name", node.member.split("%").pop()));
        title.appendChild(structEl("span", "struct-badge", node.member.split("%")[0]));
        header.appendChild(title);
        if (field) {
            const meta = structEl("div", "struct-meta");
            meta.appendChild(structEl("span", "struct-module",
                `${field.type || "?"}${structRankSuffix(field.rank)}`));
            if (field.flags && field.flags.length) {
                meta.appendChild(structEl("span", "struct-dot", "·"));
                meta.appendChild(structEl("span", "struct-loc", field.flags.join(", ")));
            }
            if (field.inheritedFrom) {
                meta.appendChild(structEl("span", "struct-dot", "·"));
                meta.appendChild(structEl("span", "struct-inherited", `declared by ${field.inheritedFrom}`));
            }
            header.appendChild(meta);
        }
        body.appendChild(header);

        if (!field) {
            const note = structEl("div", "struct-empty",
                "Unresolved route — the raw spelling is kept and never guessed.");
            body.appendChild(note);
            const gid = node.gid;
            if (gid) {
                const trace = await this.loadTrace(gid);
                if (token !== this.renderToken) return;
                if (trace) {
                    const timeline = structEl("div", "struct-timeline");
                    body.appendChild(timeline);
                    window.renderLifecycleTimeline(timeline, trace, this.manager.nodes);
                }
            }
            return;
        }

        // Origin card.
        const origin = structEl("div", "struct-origin");
        origin.appendChild(structEl("div", "struct-origin-title", "Origin"));
        let gid = field.gid;
        let trace = null;
        if (gid) {
            trace = await this.loadTrace(gid);
            if (token !== this.renderToken) return;
        }
        if (trace && trace.origin) {
            const o = trace.origin;
            origin.appendChild(structEl("div", "struct-origin-fn", o.name || "unknown"));
            origin.appendChild(structEl("div", "struct-origin-loc",
                o.file ? `${o.file}:${o.line || "?"}` : "(no file)"));
            const jump = structEl("button", "struct-action", "Jump to origin");
            jump.type = "button";
            jump.addEventListener("click", () => {
                if (typeof window.centerGraphNode === "function") window.centerGraphNode(o.node);
            });
            origin.appendChild(jump);
        } else {
            origin.appendChild(structEl("div", "struct-origin-fn", "No direct lifecycle group"));
            origin.appendChild(structEl("div", "struct-origin-loc",
                "This member is reached through its nested type; see the routes below."));
        }
        body.appendChild(origin);

        // Route table.
        const routes = this.memberRoutes(node.member);
        const routeSection = structEl("div", "struct-section");
        routeSection.appendChild(structEl("div", "struct-section-title",
            `Routes · ${routes.length}`));
        if (routes.length) {
            routeSection.appendChild(this.routeTable(routes, (route) => {
                this.push({
                    kind: "member", member: node.member, typeKey: node.typeKey,
                    route: route[0], routeMode: "route",
                });
            }));
        } else {
            routeSection.appendChild(structEl("div", "struct-empty", "No recorded route."));
        }
        body.appendChild(routeSection);

        // Sub-component facets.
        const childKey = structBaseTypeName(field.type);
        const child = this.typeOf(childKey);
        if (child && child.value) {
            const facets = structEl("div", "struct-chip-row");
            facets.appendChild(structEl("span", "struct-chip-label", "Sub-components"));
            for (const f of child.fields || []) {
                const chip = structEl("span", "struct-chip is-static", f.name);
                chip.title = `${f.type}${structRankSuffix(f.rank)}`;
                facets.appendChild(chip);
            }
            body.appendChild(facets);
        }

        const actions = structEl("div", "struct-actions");
        if (gid) {
            const traceBtn = structEl("button", "struct-action", "Trace on graph");
            traceBtn.type = "button";
            traceBtn.addEventListener("click", () => {
                if (typeof window.startTrace === "function") {
                    window.startTrace(gid, "full", null,
                        `${node.member.split("%")[0]}%${node.member.split("%").pop()}`);
                }
            });
            actions.appendChild(traceBtn);
        }
        if (child && !child.value) {
            const childBtn = structEl("button", "struct-action", `Open ${child.name}`);
            childBtn.type = "button";
            childBtn.addEventListener("click", () => this.push({ kind: "type", typeKey: childKey }));
            actions.appendChild(childBtn);
        }
        body.appendChild(actions);

        // Timeline, filtered by route scope.
        const timeline = structEl("div", "struct-timeline");
        body.appendChild(timeline);
        if (!trace) {
            timeline.appendChild(structEl("div", "struct-empty",
                "No direct read/write events for this member."));
            return;
        }
        const filtered = this.filterTrace(trace, node);
        window.renderLifecycleTimeline(timeline, filtered, this.manager.nodes);
    }

    filterTrace(trace, node) {
        if (!trace || this.state.routeMode === "all" || !node.route) return trace;
        const prefix = node.route;
        const entities = trace.entities || [];
        const events = (trace.events || []).filter((ev) => {
            const raw = (ev[4] !== null && ev[4] !== undefined && ev[4] >= 0)
                ? entities[ev[4]]
                : "";
            const ent = raw || "";
            if (!ent.startsWith("field:")) return true;
            const route = ent.slice(ent.indexOf(":") + 1);
            return route === prefix || route.startsWith(prefix + "%");
        });
        return { ...trace, events };
    }

    async renderVariable(body, node, token) {
        const rec = this.typeOf(node.typeKey);
        // Struct-typed variables redirect to their type page with the holder
        // pinned as context (plan §5 "Variable page").
        if (rec && !rec.value) {
            this.push({
                kind: "type", typeKey: node.typeKey, holder: node.holderId || this.state.holder,
            }, { replace: true });
            return;
        }
        const header = structEl("div", "struct-header");
        const title = structEl("div", "struct-title");
        title.appendChild(structEl("span", "struct-title-name", node.name || node.entity));
        if (rec) title.appendChild(structEl("span", "struct-badge", rec.name));
        header.appendChild(title);
        if (rec && rec.file) {
            header.appendChild(structEl("div", "struct-meta",
                `${rec.module || ""} · ${rec.file}${rec.line ? ":" + rec.line : ""}`));
        }
        body.appendChild(header);

        if (rec) {
            const open = structEl("button", "struct-action", `Open type ${rec.name}`);
            open.type = "button";
            open.addEventListener("click", () => this.push({ kind: "type", typeKey: node.typeKey }));
            body.appendChild(open);
        }

        const client = window.dataflowClient;
        const gid = node.gid || (node.holder && node.holder.gid)
            || await this.findGroupForEntity(node.entity);
        if (token !== this.renderToken) return;
        if (!gid) {
            body.appendChild(structEl("div", "struct-empty",
                "No read/write events were recorded for this variable."));
            return;
        }
        const trace = await this.loadTrace(gid);
        if (token !== this.renderToken) return;
        if (!trace) {
            body.appendChild(structEl("div", "struct-empty", "Trace data not available."));
            return;
        }
        const view = window.buildDataTraceView(trace, "full");
        const host = structEl("div", "struct-variable-timeline");
        body.appendChild(host);
        window.renderLifecycleInContainer(trace, view, null, host, this.manager.nodes);
    }

    async findGroupForEntity(entity) {
        // Holder chips carry the declaring entity id; the type payload does not
        // store gids for them, so ask the parameter shard-free route: try the
        // variable entity as a trace group through the search index instead.
        if (!entity) return null;
        const client = window.dataflowClient;
        if (!client || typeof client.search !== "function") return null;
        const body = entity.slice(entity.indexOf(":") + 1) || entity;
        const short = body.split("::").pop();
        const queries = body === short ? [body] : [body, short];
        for (const query of queries) {
            const results = await client.search(query, 80);
            for (const item of results || []) {
                if (item.kind === "struct") continue;
                if (item.member) continue;
                if (item.name === body || item.name === short) return item.groupId;
                if (body.endsWith("::" + item.name)) return item.groupId;
            }
        }
        return null;
    }

    async renderFunction(body, node, token) {
        const client = window.dataflowClient;
        const entries = client ? await client.getFunctionUsage(node.fnNode) : [];
        if (token !== this.renderToken) return;
        const header = structEl("div", "struct-header");
        const title = structEl("div", "struct-title");
        title.appendChild(structEl("span", "struct-title-name", node.name || node.fnId));
        header.appendChild(title);
        header.appendChild(structEl("div", "struct-meta", "Data used in this function"));
        body.appendChild(header);

        if (!entries || !entries.length) {
            body.appendChild(structEl("div", "struct-empty", "No data events recorded for this function."));
            return;
        }
        const types = entries.filter((e) => e[0] === 0);
        const vars = entries.filter((e) => e[0] === 1);
        if (types.length) {
            const section = structEl("div", "struct-section");
            section.appendChild(structEl("div", "struct-section-title", `Members · ${types.length}`));
            const list = structEl("div", "struct-function-list");
            types.forEach((entry) => {
                const member = entry[1];
                const typeKey = member.split("%")[0];
                const rec = this.typeOf(typeKey);
                const field = rec && (rec.fields || []).find((f) => f.member === member);
                const row = structEl("button", "struct-function-row");
                row.type = "button";
                row.appendChild(structEl("span", "struct-function-type", typeKey));
                row.appendChild(structEl("span", "struct-function-name", member.split("%").pop()));
                row.appendChild(structEl("span", "struct-function-mask", `${entry[3]}`));
                row.addEventListener("click", () => {
                    if (field) this.openMember(field);
                    else this.push({ kind: "member", member, typeKey });
                });
                list.appendChild(row);
            });
            section.appendChild(list);
            body.appendChild(section);
        }
        if (vars.length) {
            const section = structEl("div", "struct-section");
            section.appendChild(structEl("div", "struct-section-title", `Variables · ${vars.length}`));
            const list = structEl("div", "struct-function-list");
            vars.forEach((entry) => {
                const entity = entry[1];
                const kind = structEntityKind(entity);
                const name = entity.split("::").pop();
                const row = structEl("button", "struct-function-row");
                row.type = "button";
                row.appendChild(structEl("span", "struct-function-type", kind));
                row.appendChild(structEl("span", "struct-function-name", name));
                row.appendChild(structEl("span", "struct-function-mask", `${entry[3]}`));
                row.addEventListener("click", () => this.push({
                    kind: "variable", entity, name, gid: entry[2], typeKey: "",
                }));
                list.appendChild(row);
            });
            section.appendChild(list);
            body.appendChild(section);
        }
    }

    async showOnGraph() {
        const node = this.node();
        if (!node) return;
        if (node.kind === "type") {
            window.showStructOnGraph(node.typeKey, null, node.typeKey);
        } else if (node.kind === "member") {
            window.showStructOnGraph(node.typeKey, node.member,
                `${node.typeKey}%${node.member.split("%").pop()}`);
        } else if (node.kind === "function") {
            // Highlight every member/variable the function touches is not a
            // single touch set; use the function's own lifecycle instead.
            window.showToast && window.showToast("Open a type or member to highlight data.");
        } else {
            window.showToast && window.showToast("Open a type or member to highlight data.");
        }
    }
}

window.StructExplorer = StructExplorer;
