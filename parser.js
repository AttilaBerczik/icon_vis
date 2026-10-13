function parseDot(dotText) {
    const nodes = new Map();
    const edges = new Map();
    // Number of call sites per caller->callee pair, keyed by "from|to".
    // Populated from the GraphViz `weight` attribute emitted by callGraph.
    const edgeWeights = new Map();
    const lines = dotText.split(/\r?\n/);
    let currentNodeId = null;
    let pendingEdge = null;

    function finalizeEdge() {
        if (!pendingEdge) return;
        const key = pendingEdge.from + "|" + pendingEdge.to;
        // No parallel edges are expected, but keep the larger value defensively.
        const prev = edgeWeights.get(key);
        if (prev === undefined || pendingEdge.weight > prev) {
            edgeWeights.set(key, pendingEdge.weight);
        }
        pendingEdge = null;
    }

    for (const line of lines) {
        const edgeMatch = line.match(/^\s*(node\d+)\s*->\s*(node\d+)/);
        if (edgeMatch) {
            finalizeEdge();
            const from = edgeMatch[1];
            const to = edgeMatch[2];
            if (!edges.has(from)) {
                edges.set(from, new Set());
            }
            edges.get(from).add(to);
            pendingEdge = { from, to, weight: 1 };
            const wm = line.match(/weight=([0-9]*\.?[0-9]+)/);
            if (wm) pendingEdge.weight = parseFloat(wm[1]);
            if (line.includes("];")) finalizeEdge();
            continue;
        }

        // Edge attributes can span several lines (pos="" then weight=N];).
        if (pendingEdge) {
            const wm = line.match(/weight=([0-9]*\.?[0-9]+)/);
            if (wm) pendingEdge.weight = parseFloat(wm[1]);
            if (line.includes("];")) finalizeEdge();
            continue;
        }

        const nodeStart = line.match(/^\s*(node\d+)\s*\[/);
        if (nodeStart) {
            currentNodeId = nodeStart[1];
        }

        if (currentNodeId) {
            const labelMatch = line.match(/label="([^"]+)"/);
            if (labelMatch) {
                nodes.set(currentNodeId, labelMatch[1]);
            }
            if (line.includes("];")) {
                currentNodeId = null;
            }
        }
    }
    finalizeEdge();

    let maxWeight = 1;
    for (const w of edgeWeights.values()) {
        if (w > maxWeight) maxWeight = w;
    }

    // Expose globally so every graph renderer (main view + side-panel tabs) can
    // resolve an edge's call count without threading it through each call site.
    window.globalEdgeWeightMap = edgeWeights;
    window.globalMaxEdgeWeight = maxWeight;

    return { nodes, edges, edgeWeights };
}
