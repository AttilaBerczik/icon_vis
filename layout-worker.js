/*
 * layout-worker.js — runs the simulated-annealing ordering off the main thread
 * whenever the graph changes (hide/unhide, external libraries). The initial
 * layout comes from vis/layout.json, so this only runs on explicit changes.
 */
"use strict";

importScripts("layout.js");

self.onmessage = function(event) {
    const msg = event.data || {};
    try {
        const nodes = new Map(msg.nodes || []);
        const edges = new Map();
        for (const [from, targets] of msg.edges || []) {
            edges.set(from, new Set(targets));
        }
        const { levels, depthById } = self.buildLevels(msg.root, edges, nodes);
        const { folderOrder, fileOrderByFolder, fileMetaByKey } =
            self.buildFolderFileIndex(levels, nodes);
        const optimized = self.optimizeLayout(
            levels, depthById, nodes, edges, folderOrder, fileOrderByFolder
        );

        const fileOrderByFolderObj = {};
        optimized.fileOrderByFolder.forEach((files, folder) => {
            fileOrderByFolderObj[folder] = files;
        });
        const nodeOrderByFileDepth = {};
        optimized.nodeOrderByFileDepth.forEach((depthMap, file) => {
            const obj = {};
            depthMap.forEach((ids, depth) => {
                obj[depth] = ids;
            });
            nodeOrderByFileDepth[file] = obj;
        });
        const fileMeta = {};
        fileMetaByKey.forEach((meta, file) => {
            fileMeta[file] = meta;
        });
        self.postMessage({
            requestId: msg.requestId,
            ok: true,
            result: {
                folderOrder: optimized.folderOrder,
                fileOrderByFolder: fileOrderByFolderObj,
                nodeOrderByFileDepth,
                fileMetaByKey: fileMeta
            }
        });
    } catch (err) {
        self.postMessage({
            requestId: msg.requestId,
            ok: false,
            error: String(err && err.message || err)
        });
    }
};
