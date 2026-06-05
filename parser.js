function parseDot(dotText) {
    const nodes = new Map();
    const edges = new Map();
    const lines = dotText.split(/\r?\n/);
    let currentNodeId = null;

    for (const line of lines) {
        const edgeMatch = line.match(/^\s*(node\d+)\s*->\s*(node\d+)/);
        if (edgeMatch) {
            const from = edgeMatch[1];
            const to = edgeMatch[2];
            if (!edges.has(from)) {
                edges.set(from, new Set());
            }
            edges.get(from).add(to);
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

    return { nodes, edges };
}
