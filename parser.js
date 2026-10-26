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
    publishEdgeWeights(edgeWeights);
    return { nodes, edges, edgeWeights, programIds: [] };
}

// Reads the networkx node-link JSON written by extract_graph.py into the same
// shape as parseDot. For now only function nodes and call edges are used; the
// label is built like the old one: "folder\nfile\nfunction".
function parseGraphJson(data) {
    const nodes = new Map();
    const edges = new Map();
    const edgeWeights = new Map();
    // PROGRAM units, the counterpart of callGraph's "__MAIN__" node.
    const programIds = [];

    for (const n of data.nodes) {
        if (n.kind !== "function") continue;
        const fileName = n.file.split("/").pop();
        nodes.set(n.id, `${n.folder}\\n${fileName}\\n${n.name}`);
        if (n.program) programIds.push(n.id);
    }
    for (const e of data.edges) {
        if (e.kind !== "call" || !nodes.has(e.source) || !nodes.has(e.target)) continue;
        if (!edges.has(e.source)) edges.set(e.source, new Set());
        edges.get(e.source).add(e.target);
        edgeWeights.set(e.source + "|" + e.target, e.weight);
    }
    publishEdgeWeights(edgeWeights);
    return { nodes, edges, edgeWeights, programIds };
}

// Expose globally so every graph renderer (main view + side-panel tabs) can
// resolve an edge's call count without threading it through each call site.
function publishEdgeWeights(edgeWeights) {
    let maxWeight = 1;
    for (const w of edgeWeights.values()) {
        if (w > maxWeight) maxWeight = w;
    }
    window.globalEdgeWeightMap = edgeWeights;
    window.globalMaxEdgeWeight = maxWeight;
}
