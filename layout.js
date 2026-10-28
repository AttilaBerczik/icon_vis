// Label parsing is called many times per node during layout/rendering. Labels
// are immutable, so memoize the split result (keyed by the raw label string) to
// avoid re-splitting the same strings tens of thousands of times.
const _nodeLabelCache = new Map();

function parseNodeLabel(rawLabel) {
    const label = rawLabel == null ? "" : String(rawLabel);
    const cached = _nodeLabelCache.get(label);
    if (cached) return cached;

    const lines = label.split(/\\n|\n/);
    let result;
    if (lines.length >= 3) {
        result = { folder: lines[0], file: lines[1], lines };
    } else if (lines.length === 2) {
        result = { folder: "", file: lines[0], lines };
    } else {
        result = { folder: "", file: lines[0] || label, lines };
    }
    _nodeLabelCache.set(label, result);
    return result;
}

function makeFileKey(folder, file) {
    if (folder && file) {
        return `${folder}/${file}`;
    }
    return file || folder || "";
}

function makeDAG(rootId, edges) {
    const dagEdges = new Map();
    const visited = new Set();
    const stack = new Set();

    function dfs(u) {
        visited.add(u);
        stack.add(u);
        const neighbors = edges.get(u) || [];
        const dagNeighbors = [];
        for (const v of neighbors) {
            if (!visited.has(v)) {
                dagNeighbors.push(v);
                dfs(v);
            } else if (!stack.has(v)) {
                dagNeighbors.push(v);
            }
        }
        if (dagNeighbors.length > 0) {
            dagEdges.set(u, dagNeighbors);
        }
        stack.delete(u);
    }
    dfs(rootId);
    return dagEdges;
}

function getPredecessors(V, dagEdges) {
    const preds = new Map();
    for (const v of V) preds.set(v, []);
    for (const [u, targets] of dagEdges.entries()) {
        for (const v of targets) preds.get(v).push(u);
    }
    return preds;
}

function longestPathAlgorithm(V, dagEdges, preds) {
    const layering = new Map();
    const U = new Set();
    let Z = new Set();
    let currentLayer = 1;

    const outDegCount = new Map();
    for (const v of V) outDegCount.set(v, (dagEdges.get(v) || []).length);

    while (U.size < V.size) {
        const ready = [];
        for (const v of V) {
            if (!U.has(v) && outDegCount.get(v) === 0) {
                ready.push(v);
            }
        }

        if (ready.length > 0) {
            for (const v of ready) {
                layering.set(v, currentLayer);
                U.add(v);
            }
        } else {
            currentLayer++;
            for (const v of U) {
                if (!Z.has(v)) {
                    Z.add(v);
                    for (const p of (preds.get(v) || [])) {
                        outDegCount.set(p, outDegCount.get(p) - 1);
                    }
                }
            }
        }
    }
    return layering;
}

function promoteNode(v, layering, preds, dagEdges, modified) {
    let dummydiff = 0;
    const vLayer = layering.get(v);

    for (const u of (preds.get(v) || [])) {
        if (layering.get(u) === vLayer + 1) {
            dummydiff += promoteNode(u, layering, preds, dagEdges, modified);
        }
    }

    layering.set(v, vLayer + 1);
    modified.push(v);

    const inDeg = (preds.get(v) || []).length;
    const outDeg = (dagEdges.get(v) || []).length;
    dummydiff += (-inDeg + outDeg);

    return dummydiff;
}

function nodePromotionHeuristic(V, dagEdges, preds, layering) {
    // `layeringBackUp` always mirrors the last *accepted* layering. A promotion
    // attempt records exactly which nodes it touched, so we only copy those back
    // on rejection (instead of re-copying / restoring the whole map, which was
    // O(V) per node and dominated the layout time on large graphs).
    const layeringBackUp = new Map(layering);
    let promotions;

    do {
        promotions = 0;
        for (const v of V) {
            const inDeg = (preds.get(v) || []).length;
            if (inDeg > 0) {
                const modified = [];
                const diff = promoteNode(v, layering, preds, dagEdges, modified);
                if (diff < 0) {
                    promotions++;
                    for (const id of modified) layeringBackUp.set(id, layering.get(id));
                } else {
                    for (const id of modified) layering.set(id, layeringBackUp.get(id));
                }
            }
        }
    } while (promotions > 0);

    return layering;
}

// --- Hidden folder / file filtering -----------------------------------------
// Right-clicking a folder or file hides it (sets live on `window`, see
// render.js). While "Show Hidden" is off, hidden nodes are removed from the
// graph before the layer assignment runs, so the layout closes up around them
// instead of leaving empty rows behind.
function isHiddenVisibilityFilterActive() {
    if (typeof window === "undefined" || window.showHiddenFiles) return false;
    const folders = window.hiddenFolders;
    const files = window.hiddenFiles;
    return !!((folders && folders.size) || (files && files.size));
}

function isGraphNodeHidden(id, nodes) {
    if (id == null || String(id).startsWith("dummy|")) return false;
    if (!isHiddenVisibilityFilterActive()) return false;

    const rawLabel = (nodes && nodes.get(id)) || id;
    const info = parseNodeLabel(rawLabel);
    if (info.folder && window.hiddenFolders && window.hiddenFolders.has(info.folder)) return true;

    const fileKey = makeFileKey(info.folder, info.file);
    return !!(fileKey && window.hiddenFiles && window.hiddenFiles.has(fileKey));
}

function buildVisibleEdgeMap(edges, nodes) {
    const visibleEdges = new Map();
    for (const [from, targets] of edges.entries()) {
        if (isGraphNodeHidden(from, nodes)) continue;

        const keptTargets = [];
        for (const target of targets) {
            if (!isGraphNodeHidden(target, nodes)) keptTargets.push(target);
        }
        if (keptTargets.length > 0) visibleEdges.set(from, keptTargets);
    }
    return visibleEdges;
}

function buildLevels(rootId, edges, nodes) {
    const layoutEdges = isHiddenVisibilityFilterActive()
        ? buildVisibleEdgeMap(edges, nodes)
        : edges;
    const dagEdges = makeDAG(rootId, layoutEdges);

    const V = new Set();
    V.add(rootId);
    for (const [u, targets] of dagEdges.entries()) {
        V.add(u);
        for (const v of targets) V.add(v);
    }

    const preds = getPredecessors(V, dagEdges);
    let layering = longestPathAlgorithm(V, dagEdges, preds);
    layering = nodePromotionHeuristic(V, dagEdges, preds, layering);

    let maxLayer = 0;
    for (const l of layering.values()) {
        if (l > maxLayer) maxLayer = l;
    }

    const topDownLayering = new Map();
    for (const [v, l] of layering.entries()) {
        topDownLayering.set(v, maxLayer - l);
    }

    const levels = Array.from({ length: maxLayer + 1 }, () => []);
    const depthById = new Map();

    for (const [v, l] of topDownLayering.entries()) {
        levels[l].push(v);
        depthById.set(v, l);
    }

    edges.clear();
    
    for (const [u, targets] of dagEdges.entries()) {
        const layerU = topDownLayering.get(u);
        for (const v of targets) {
            const layerV = topDownLayering.get(v);
            if (layerV > layerU + 1) {
                let prev = u;
                for (let l = layerU + 1; l < layerV; l++) {
                    const dummyId = `dummy|${u}|${v}|${l}`;
                    levels[l].push(dummyId);
                    depthById.set(dummyId, l);
                    
                    const vLabel = nodes.get(v) || String(v);
                    nodes.set(dummyId, vLabel);

                    if (!edges.has(prev)) edges.set(prev, []);
                    edges.get(prev).push(dummyId);
                    
                    prev = dummyId;
                }
                if (!edges.has(prev)) edges.set(prev, []);
                edges.get(prev).push(v);
            } else {
                if (!edges.has(u)) edges.set(u, []);
                edges.get(u).push(v);
            }
        }
    }

    return { levels, depthById };
}

function getNodeFolder(id, nodes) {
    const rawLabel = nodes.get(id) || id;
    return parseNodeLabel(rawLabel).folder;
}

function getNodeFile(id, nodes) {
    const rawLabel = nodes.get(id) || id;
    return parseNodeLabel(rawLabel).file;
}

function getNodeFileKey(id, nodes) {
    const rawLabel = nodes.get(id) || id;
    const { folder, file } = parseNodeLabel(rawLabel);
    return makeFileKey(folder, file);
}

function buildFolderFileIndex(levels, nodes) {
    const folderOrder = [];
    const fileOrderByFolder = new Map();
    const fileMetaByKey = new Map();
    const folderSeen = new Set();
    const fileSeenByFolder = new Map();

    levels.forEach((levelIds) => {
        levelIds.forEach((id) => {
            if (String(id).startsWith("dummy|")) return;

            const folder = getNodeFolder(id, nodes);
            const file = getNodeFile(id, nodes);
            const fileKey = makeFileKey(folder, file);

            if (!folderSeen.has(folder)) {
                folderSeen.add(folder);
                folderOrder.push(folder);
                fileOrderByFolder.set(folder, []);
                fileSeenByFolder.set(folder, new Set());
            }

            const fileSeen = fileSeenByFolder.get(folder);
            if (!fileSeen.has(fileKey)) {
                fileSeen.add(fileKey);
                fileOrderByFolder.get(folder).push(fileKey);
            }

            if (!fileMetaByKey.has(fileKey)) {
                fileMetaByKey.set(fileKey, { folder, file });
            }
        });
    });

    return { folderOrder, fileOrderByFolder, fileMetaByKey };
}

function buildInitialLayout(levels, nodes, fileOrderByFolder) {
    const nodeOrderByFileDepth = new Map();
    for (const files of fileOrderByFolder.values()) {
        files.forEach((f) => nodeOrderByFileDepth.set(f, new Map()));
    }

    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const fileKey = getNodeFileKey(id, nodes);
            if (!nodeOrderByFileDepth.has(fileKey)) {
                nodeOrderByFileDepth.set(fileKey, new Map());
            }
            const depthMap = nodeOrderByFileDepth.get(fileKey);
            if (!depthMap.has(depth)) {
                depthMap.set(depth, []);
            }
            depthMap.get(depth).push(id);
        });
    });

    return { nodeOrderByFileDepth };
}

function buildEdgesByDepth(edges, depthById) {
    const edgesByDepth = new Map();
    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined) {
            continue;
        }
        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) {
                continue;
            }
            if (!edgesByDepth.has(fromDepth)) {
                edgesByDepth.set(fromDepth, []);
            }
            edgesByDepth.get(fromDepth).push([from, target]);
        }
    }
    return edgesByDepth;
}

function buildIndexByDepth(levels, fileOrder, nodeOrderByFileDepth) {
    const indexByDepth = new Map();
    levels.forEach((_, depth) => {
        const map = new Map();
        let index = 0;
        fileOrder.forEach((file) => {
            const depthMap = nodeOrderByFileDepth.get(file);
            const ids = depthMap ? depthMap.get(depth) : null;
            if (!ids || ids.length === 0) {
                return;
            }
            ids.forEach((id) => {
                map.set(id, index);
                index += 1;
            });
        });
        indexByDepth.set(depth, map);
    });
    return indexByDepth;
}

function flattenFileOrder(folderOrder, fileOrderByFolder) {
    const fileOrder = [];
    folderOrder.forEach((folder) => {
        const files = fileOrderByFolder.get(folder);
        if (files && files.length) {
            fileOrder.push(...files);
        }
    });
    return fileOrder;
}

function computeTotalEdgeLength(levels, edgesByDepth, folderOrder, fileOrderByFolder, nodeOrderByFileDepth) {
    const fileOrder = flattenFileOrder(folderOrder, fileOrderByFolder);
    const indexByDepth = buildIndexByDepth(levels, fileOrder, nodeOrderByFileDepth);
    let totalLength = 0;

    for (let depth = 0; depth < levels.length - 1; depth += 1) {
        const edgesLayer = edgesByDepth.get(depth);
        if (!edgesLayer) {
            continue;
        }

        const sourceIndex = indexByDepth.get(depth);
        const targetIndex = indexByDepth.get(depth + 1);
        if (!sourceIndex || !targetIndex) {
            continue;
        }

        for (const [from, to] of edgesLayer) {
            const s = sourceIndex.get(from);
            const t = targetIndex.get(to);
            if (s !== undefined && t !== undefined) {
                // Use Math.abs for linear distance. Math.abs(s - t)
                // Alternatively, use Math.pow(s - t, 2) to heavily penalize very long edges.
                totalLength += Math.pow(s - t, 2);
            }
        }
    }

    return totalLength;
}

function cloneNodeOrder(nodeOrderByFileDepth) {
    const clone = new Map();
    for (const [file, depthMap] of nodeOrderByFileDepth.entries()) {
        const depthClone = new Map();
        for (const [depth, ids] of depthMap.entries()) {
            depthClone.set(depth, ids.slice());
        }
        clone.set(file, depthClone);
    }
    return clone;
}

function cloneFileOrderByFolder(fileOrderByFolder) {
    const clone = new Map();
    for (const [folder, files] of fileOrderByFolder.entries()) {
        clone.set(folder, files.slice());
    }
    return clone;
}

function optimizeLayout(levels, depthById, nodes, edges, folderOrderInput, fileOrderByFolderInput) {
    const folderOrder = folderOrderInput.slice();
    const fileOrderByFolder = cloneFileOrderByFolder(fileOrderByFolderInput);
    const { nodeOrderByFileDepth } = buildInitialLayout(levels, nodes, fileOrderByFolder);
    const edgesByDepth = buildEdgesByDepth(edges, depthById);

    // Switch to edge length evaluation
    let currentLength = computeTotalEdgeLength(
        levels,
        edgesByDepth,
        folderOrder,
        fileOrderByFolder,
        nodeOrderByFileDepth
    );

    if (currentLength === 0) {
        return { folderOrder, fileOrderByFolder, nodeOrderByFileDepth };
    }

    const totalNodes = levels.reduce((acc, level) => acc + level.length, 0);
    const iterations = Math.min(5000, Math.max(1500, totalNodes * 30));
    const initialTemp = Math.max(1, currentLength * 0.25);
    const cooling = 0.995;

    // Simulated annealing is a heuristic: instead of always burning the full
    // iteration budget (which took multiple seconds on the ICON graph and froze
    // the tab before anything was drawn), bound it by wall-clock time. The vast
    // majority of the improvement happens early, so the result stays close while
    // startup becomes predictable on slower machines too.
    const nowMs = () => (typeof performance !== "undefined" && performance.now)
        ? performance.now()
        : Date.now();
    const startTime = nowMs();
    const TIME_BUDGET_MS = 1000;

    const swapCandidates = [];
    for (const [file, depthMap] of nodeOrderByFileDepth.entries()) {
        for (const [depth, ids] of depthMap.entries()) {
            if (ids.length >= 2) {
                swapCandidates.push({ file, depth });
            }
        }
    }

    const fileSwapCandidates = folderOrder.filter((folder) => {
        const files = fileOrderByFolder.get(folder);
        return files && files.length >= 2;
    });

    const hasNodeSwap = swapCandidates.length > 0;
    const hasFileSwap = fileSwapCandidates.length > 0;
    const hasFolderSwap = folderOrder.length >= 2;
    if (!hasNodeSwap && !hasFileSwap && !hasFolderSwap) {
        return { folderOrder, fileOrderByFolder, nodeOrderByFileDepth };
    }

    let bestLength = currentLength;
    let bestFolderOrder = folderOrder.slice();
    let bestFileOrderByFolder = cloneFileOrderByFolder(fileOrderByFolder);
    let bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);

    for (let i = 0; i < iterations; i += 1) {
        if ((i & 31) === 0 && nowMs() - startTime > TIME_BUDGET_MS) break;
        const temperature = Math.max(0.001, initialTemp * Math.pow(cooling, i));
        const moveTypes = [];
        if (hasNodeSwap) moveTypes.push("nodeSwap");
        if (hasFileSwap) moveTypes.push("fileSwap");
        if (hasFolderSwap) moveTypes.push("folderSwap");

        const moveType = moveTypes[Math.floor(Math.random() * moveTypes.length)];

        if (moveType === "nodeSwap") {
            const pick = swapCandidates[Math.floor(Math.random() * swapCandidates.length)];
            const depthMap = nodeOrderByFileDepth.get(pick.file);
            const ids = depthMap.get(pick.depth);
            const a = Math.floor(Math.random() * ids.length);
            let b = Math.floor(Math.random() * ids.length);
            while (b === a) b = Math.floor(Math.random() * ids.length);

            const tmp = ids[a];
            ids[a] = ids[b];
            ids[b] = tmp;

            const newLength = computeTotalEdgeLength(
                levels,
                edgesByDepth,
                folderOrder,
                fileOrderByFolder,
                nodeOrderByFileDepth
            );
            const accept =
                newLength < currentLength ||
                Math.random() < Math.exp((currentLength - newLength) / temperature);

            if (accept) {
                currentLength = newLength;
                if (newLength < bestLength) {
                    bestLength = newLength;
                    bestFolderOrder = folderOrder.slice();
                    bestFileOrderByFolder = cloneFileOrderByFolder(fileOrderByFolder);
                    bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);
                }
            } else {
                const revert = ids[a];
                ids[a] = ids[b];
                ids[b] = revert;
            }
        } else if (moveType === "fileSwap") {
            const folder = fileSwapCandidates[Math.floor(Math.random() * fileSwapCandidates.length)];
            const files = fileOrderByFolder.get(folder);
            const a = Math.floor(Math.random() * files.length);
            let b = Math.floor(Math.random() * files.length);
            while (b === a) b = Math.floor(Math.random() * files.length);

            const tmp = files[a];
            files[a] = files[b];
            files[b] = tmp;

            const newLength = computeTotalEdgeLength(
                levels,
                edgesByDepth,
                folderOrder,
                fileOrderByFolder,
                nodeOrderByFileDepth
            );
            const accept =
                newLength < currentLength ||
                Math.random() < Math.exp((currentLength - newLength) / temperature);

            if (accept) {
                currentLength = newLength;
                if (newLength < bestLength) {
                    bestLength = newLength;
                    bestFolderOrder = folderOrder.slice();
                    bestFileOrderByFolder = cloneFileOrderByFolder(fileOrderByFolder);
                    bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);
                }
            } else {
                const revert = files[a];
                files[a] = files[b];
                files[b] = revert;
            }
        } else {
            const a = Math.floor(Math.random() * folderOrder.length);
            let b = Math.floor(Math.random() * folderOrder.length);
            while (b === a) b = Math.floor(Math.random() * folderOrder.length);

            const tmp = folderOrder[a];
            folderOrder[a] = folderOrder[b];
            folderOrder[b] = tmp;

            const newLength = computeTotalEdgeLength(
                levels,
                edgesByDepth,
                folderOrder,
                fileOrderByFolder,
                nodeOrderByFileDepth
            );
            const accept =
                newLength < currentLength ||
                Math.random() < Math.exp((currentLength - newLength) / temperature);

            if (accept) {
                currentLength = newLength;
                if (newLength < bestLength) {
                    bestLength = newLength;
                    bestFolderOrder = folderOrder.slice();
                    bestFileOrderByFolder = cloneFileOrderByFolder(fileOrderByFolder);
                    bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);
                }
            } else {
                const revert = folderOrder[a];
                folderOrder[a] = folderOrder[b];
                folderOrder[b] = revert;
            }
        }
    }

    return {
        folderOrder: bestFolderOrder,
        fileOrderByFolder: bestFileOrderByFolder,
        nodeOrderByFileDepth: bestNodeOrder
    };
}

function cloneEdges(edges) {
    const clone = new Map();
    for (const [from, targets] of edges) {
        clone.set(from, new Set(targets));
    }
    return clone;
}

function cloneNodes(nodes) {
    return new Map(nodes);
}

function buildReverseEdgeMap(edges) {
    const reverse = new Map();
    for (const [from, targets] of edges) {
        for (const target of targets) {
            if (!reverse.has(target)) reverse.set(target, new Set());
            reverse.get(target).add(from);
        }
    }
    return reverse;
}

function flipGraph(levels, depthById, edges) {
    const maxDepth = levels.length - 1;

    const flippedLevels = levels.slice().reverse();

    const flippedDepth = new Map();
    for (const [id, depth] of depthById) {
        flippedDepth.set(id, maxDepth - depth);
    }

    const flippedEdges = new Map();
    for (const [from, targets] of edges) {
        for (const target of targets) {
            if (!flippedEdges.has(target)) flippedEdges.set(target, []);
            flippedEdges.get(target).push(from);
        }
    }

    return { levels: flippedLevels, depthById: flippedDepth, edges: flippedEdges };
}

function buildCombinedGraph(nodeId, nodes, edges) {
    const origEdges = cloneEdges(edges);
    const origNodes = cloneNodes(nodes);

    // 1. Build Callers (above nodeId, flipped so callers are at top layers pointing to nodeId)
    const reverseEdges = buildReverseEdgeMap(origEdges);
    const callerNodes = cloneNodes(origNodes);
    const { levels: rawCallerLevels, depthById: rawCallerDepth } = buildLevels(nodeId, reverseEdges, callerNodes);

    let callerLevels, callerEdges, callerDepth;
    const hasCallers = rawCallerLevels.length > 1;
    if (hasCallers) {
        const flipped = flipGraph(rawCallerLevels, rawCallerDepth, reverseEdges);
        callerLevels = flipped.levels;
        callerEdges = flipped.edges;
        callerDepth = flipped.depthById;
    } else {
        callerLevels = [[nodeId]];
        callerEdges = new Map();
        callerDepth = new Map([[nodeId, 0]]);
    }

    // 2. Build Callees (below nodeId, pointing downward from nodeId)
    const calleeEdges = cloneEdges(origEdges);
    const calleeNodes = cloneNodes(origNodes);
    const { levels: calleeLevels, depthById: calleeDepth } = buildLevels(nodeId, calleeEdges, calleeNodes);
    const hasCallees = calleeLevels.length > 1;

    const callerOffset = callerLevels.length - 1;
    const combinedLevels = [];
    const combinedDepthById = new Map();
    const combinedNodes = cloneNodes(nodes);
    const combinedEdges = new Map();

    // Add caller levels (0 to callerOffset - 1)
    for (let l = 0; l < callerOffset; l++) {
        combinedLevels.push(callerLevels[l].slice());
        for (const id of callerLevels[l]) {
            combinedDepthById.set(id, l);
            if (callerNodes.has(id)) combinedNodes.set(id, callerNodes.get(id));
        }
    }

    // Middle level: nodeId
    combinedLevels.push([nodeId]);
    combinedDepthById.set(nodeId, callerOffset);

    // Add callee levels (1 to calleeLevels.length - 1)
    for (let l = 1; l < calleeLevels.length; l++) {
        const targetLevel = callerOffset + l;
        combinedLevels.push(calleeLevels[l].slice());
        for (const id of calleeLevels[l]) {
            combinedDepthById.set(id, targetLevel);
            if (calleeNodes.has(id)) combinedNodes.set(id, calleeNodes.get(id));
        }
    }

    // Combine edges
    for (const [from, targets] of callerEdges.entries()) {
        combinedEdges.set(from, Array.from(targets));
    }
    for (const [from, targets] of calleeEdges.entries()) {
        if (!combinedEdges.has(from)) {
            combinedEdges.set(from, Array.from(targets));
        } else {
            const existing = new Set(combinedEdges.get(from));
            for (const t of targets) existing.add(t);
            combinedEdges.set(from, Array.from(existing));
        }
    }

    return {
        levels: combinedLevels,
        depthById: combinedDepthById,
        nodes: combinedNodes,
        edges: combinedEdges,
        hasCallers,
        hasCallees,
        focusDepth: callerOffset
    };
}

// UMD-style export so the layout can be computed headlessly in Node during the
// offline viewer build (see build_layout.js) without duplicating any code.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        parseNodeLabel,
        makeFileKey,
        makeDAG,
        buildLevels,
        buildFolderFileIndex,
        buildInitialLayout,
        flattenFileOrder,
        optimizeLayout,
        getNodeFolder,
        getNodeFile,
        getNodeFileKey,
        buildReverseEdgeMap,
        flipGraph,
        buildCombinedGraph,
        cloneNodes,
        cloneEdges
    };
}