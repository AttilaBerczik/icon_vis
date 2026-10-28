// --- DOT parser (legacy: ?source=dot) ---------------------------------------
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

    return { nodes, edges, edgeWeights, meta: { source: "dot" } };
}

// --- Static data-flow graph parser (vis/graph.json) -------------------------
// The browser receives the same shape as parseDot: a Map of node id -> label
// ("folder\nfile\nfunction") and a Map of edges. Integer ids keep the payload
// small; labels are rebuilt from string tables so layout.js and render.js keep
// working unchanged.
function parseGraphJson(payload) {
    const ids = payload.ids || [];
    const names = payload.names || [];
    const folders = payload.folders || [];
    const files = payload.files || [];
    const kinds = payload.kinds || [];
    const execSpaces = payload.execSpaces || [];
    const libraries = payload.libraries || [];
    const components = payload.components || [];
    const fnShards = payload.fnShards || [];

    const nodes = new Map();
    const edges = new Map();
    const edgeWeights = new Map();
    const functionToNode = new Map();
    const nodeToFunction = [];
    const nodeRecords = [];

    for (const row of payload.nodes || []) {
        const id = row[0];
        const name = names[id] || ids[id] || String(id);
        const folder = folders[row[2]] || "";
        const file = files[row[3]] || "";
        nodes.set(id, folder ? `${folder}\\n${file}\\n${name}` : `${file}\\n${name}`);
        nodeToFunction[id] = ids[id];
        if (ids[id]) functionToNode.set(ids[id], id);
        nodeRecords[id] = {
            id,
            functionId: ids[id],
            name,
            folder,
            file,
            kind: kinds[row[1]] || "function",
            exec: execSpaces[row[4]] || "unknown",
            flags: row[5],
            external: !!(row[5] & 1),
            isCpp: !!(row[5] & 2),
            paramCount: row[6] || 0,
            readCount: row[7] || 0,
            writeCount: row[8] || 0,
            component: components[row[9]] || "",
            shard: fnShards[row[10]] || null,
            library: row[11] >= 0 ? (libraries[row[11]] || "external") : null,
            line: row[12] || 0
        };
    }

    const rawEdges = payload.edges || [];
    for (let i = 0; i < rawEdges.length; i += 5) {
        const from = rawEdges[i];
        const to = rawEdges[i + 1];
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from).add(to);
        edgeWeights.set(`${from}|${to}`, rawEdges[i + 2] || 1);
    }

    let maxWeight = 1;
    for (const w of edgeWeights.values()) {
        if (w > maxWeight) maxWeight = w;
    }
    window.globalEdgeWeightMap = edgeWeights;
    window.globalMaxEdgeWeight = maxWeight;

    return {
        nodes,
        edges,
        edgeWeights,
        meta: {
            source: "dataflow",
            root: payload.root,
            rootId: payload.rootId,
            counts: payload.counts || {},
            folders,
            files,
            libraries,
            kinds,
            execSpaces,
            components,
            fnShards,
            ids,
            names,
            functionToNode,
            nodeToFunction,
            nodeRecords
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseDot, parseGraphJson };
}
