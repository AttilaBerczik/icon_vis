const MAX_DEPTH = 3;

function parseNodeLabel(rawLabel) {
    const label = rawLabel ?? "";
    const lines = String(label).split(/\\n|\n/);
    if (lines.length >= 3) {
        return { folder: lines[0], file: lines[1], lines };
    }
    if (lines.length === 2) {
        return { folder: "", file: lines[0], lines };
    }
    return { folder: "", file: lines[0] || String(label), lines };
}

function makeFileKey(folder, file) {
    if (folder && file) {
        return `${folder}/${file}`;
    }
    return file || folder || "";
}

function buildLevels(rootId, edges) {
    const levels = Array.from({ length: MAX_DEPTH + 1 }, () => []);
    const depthById = new Map();
    const queue = [rootId];

    levels[0].push(rootId);
    depthById.set(rootId, 0);

    while (queue.length) {
        const current = queue.shift();
        const depth = depthById.get(current);
        if (depth === MAX_DEPTH) {
            continue;
        }
        const neighbors = edges.get(current);
        if (!neighbors) {
            continue;
        }
        for (const neighbor of neighbors) {
            if (depthById.has(neighbor)) {
                continue;
            }
            depthById.set(neighbor, depth + 1);
            levels[depth + 1].push(neighbor);
            queue.push(neighbor);
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
        if (fromDepth === undefined || fromDepth >= MAX_DEPTH) {
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

function fenwickAdd(bit, index, delta) {
    for (let i = index; i < bit.length; i += i & -i) {
        bit[i] += delta;
    }
}

function fenwickSum(bit, index) {
    let sum = 0;
    for (let i = index; i > 0; i -= i & -i) {
        sum += bit[i];
    }
    return sum;
}

function countCrossingsForLayer(edgesLayer, sourceIndex, targetIndex) {
    const pairs = [];
    for (const [from, to] of edgesLayer) {
        const s = sourceIndex.get(from);
        const t = targetIndex.get(to);
        if (s === undefined || t === undefined) {
            continue;
        }
        pairs.push([s, t]);
    }
    if (pairs.length < 2) {
        return 0;
    }
    pairs.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const maxIndex = targetIndex.size;
    if (maxIndex <= 1) {
        return 0;
    }
    const bit = new Array(maxIndex + 1).fill(0);
    let inversions = 0;
    let seen = 0;
    for (const pair of pairs) {
        const t = pair[1] + 1;
        const lessOrEqual = fenwickSum(bit, t);
        inversions += seen - lessOrEqual;
        fenwickAdd(bit, t, 1);
        seen += 1;
    }
    return inversions;
}

function countCrossings(levels, edgesByDepth, folderOrder, fileOrderByFolder, nodeOrderByFileDepth) {
    const fileOrder = flattenFileOrder(folderOrder, fileOrderByFolder);
    const indexByDepth = buildIndexByDepth(levels, fileOrder, nodeOrderByFileDepth);
    let total = 0;
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
        const edgesLayer = edgesByDepth.get(depth);
        if (!edgesLayer || edgesLayer.length < 2) {
            continue;
        }
        const sourceIndex = indexByDepth.get(depth);
        const targetIndex = indexByDepth.get(depth + 1);
        if (!sourceIndex || !targetIndex) {
            continue;
        }
        total += countCrossingsForLayer(edgesLayer, sourceIndex, targetIndex);
    }
    return total;
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
    let currentCrossings = countCrossings(
        levels,
        edgesByDepth,
        folderOrder,
        fileOrderByFolder,
        nodeOrderByFileDepth
    );
    if (currentCrossings === 0) {
        return { folderOrder, fileOrderByFolder, nodeOrderByFileDepth };
    }

    const totalNodes = levels.reduce((acc, level) => acc + level.length, 0);
    const iterations = Math.min(5000, Math.max(1500, totalNodes * 30));
    const initialTemp = Math.max(1, currentCrossings * 0.25);
    const cooling = 0.995;

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

    let bestCrossings = currentCrossings;
    let bestFolderOrder = folderOrder.slice();
    let bestFileOrderByFolder = cloneFileOrderByFolder(fileOrderByFolder);
    let bestNodeOrder = cloneNodeOrder(nodeOrderByFileDepth);

    for (let i = 0; i < iterations; i += 1) {
        const temperature = Math.max(0.001, initialTemp * Math.pow(cooling, i));
        const moveTypes = [];
        if (hasNodeSwap) {
            moveTypes.push("nodeSwap");
        }
        if (hasFileSwap) {
            moveTypes.push("fileSwap");
        }
        if (hasFolderSwap) {
            moveTypes.push("folderSwap");
        }
        const moveType = moveTypes[Math.floor(Math.random() * moveTypes.length)];

        if (moveType === "nodeSwap") {
            const pick = swapCandidates[Math.floor(Math.random() * swapCandidates.length)];
            const depthMap = nodeOrderByFileDepth.get(pick.file);
            const ids = depthMap.get(pick.depth);
            const a = Math.floor(Math.random() * ids.length);
            let b = Math.floor(Math.random() * ids.length);
            while (b === a) {
                b = Math.floor(Math.random() * ids.length);
            }
            const tmp = ids[a];
            ids[a] = ids[b];
            ids[b] = tmp;

            const newCrossings = countCrossings(
                levels,
                edgesByDepth,
                folderOrder,
                fileOrderByFolder,
                nodeOrderByFileDepth
            );
            const accept =
                newCrossings < currentCrossings ||
                Math.random() < Math.exp((currentCrossings - newCrossings) / temperature);
            if (accept) {
                currentCrossings = newCrossings;
                if (newCrossings < bestCrossings) {
                    bestCrossings = newCrossings;
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
            while (b === a) {
                b = Math.floor(Math.random() * files.length);
            }
            const tmp = files[a];
            files[a] = files[b];
            files[b] = tmp;

            const newCrossings = countCrossings(
                levels,
                edgesByDepth,
                folderOrder,
                fileOrderByFolder,
                nodeOrderByFileDepth
            );
            const accept =
                newCrossings < currentCrossings ||
                Math.random() < Math.exp((currentCrossings - newCrossings) / temperature);
            if (accept) {
                currentCrossings = newCrossings;
                if (newCrossings < bestCrossings) {
                    bestCrossings = newCrossings;
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
            while (b === a) {
                b = Math.floor(Math.random() * folderOrder.length);
            }
            const tmp = folderOrder[a];
            folderOrder[a] = folderOrder[b];
            folderOrder[b] = tmp;

            const newCrossings = countCrossings(
                levels,
                edgesByDepth,
                folderOrder,
                fileOrderByFolder,
                nodeOrderByFileDepth
            );
            const accept =
                newCrossings < currentCrossings ||
                Math.random() < Math.exp((currentCrossings - newCrossings) / temperature);
            if (accept) {
                currentCrossings = newCrossings;
                if (newCrossings < bestCrossings) {
                    bestCrossings = newCrossings;
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
