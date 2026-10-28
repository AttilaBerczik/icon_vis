#!/usr/bin/env node
/*
 * Offline layout step for the static viewer.
 *
 *   node build_layout.js vis/graph.json vis/layout.json
 *
 * Uses the *same* layout.js that the browser runs, so the ordering algorithm is
 * never duplicated. The browser only falls back to a real annealing run when it
 * hides/unhides items or toggles external libraries.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./layout.js");

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(argv) {
    const graphPath = argv[0] || path.join("vis", "graph.json");
    const outPath = argv[1] || path.join(path.dirname(graphPath), "layout.json");
    const graph = readJson(graphPath);

    // External stubs are hidden by default in the viewer. The cached layout
    // therefore describes the real-only graph, which is what first paint shows.
    const nodes = new Map();
    graph.nodes.forEach((row) => {
        const id = row[0];
        const external = !!(row[5] & 1);
        if (external) return;
        const folder = graph.folders[row[2]] || "";
        const file = graph.files[row[3]] || "";
        const name = graph.names[row[0]] || String(id);
        nodes.set(id, folder ? `${folder}\n${file}\n${name}` : `${file}\n${name}`);
    });

    const edges = new Map();
    for (let i = 0; i < graph.edges.length; i += 5) {
        const from = graph.edges[i];
        const to = graph.edges[i + 1];
        if (!nodes.has(from) || !nodes.has(to)) continue;
        let targets = edges.get(from);
        if (!targets) {
            targets = new Set();
            edges.set(from, targets);
        }
        targets.add(to);
    }

    const { levels, depthById } = L.buildLevels(graph.root, edges, nodes);
    const { folderOrder, fileOrderByFolder, fileMetaByKey } = L.buildFolderFileIndex(levels, nodes);
    const optimized = L.optimizeLayout(levels, depthById, nodes, edges, folderOrder, fileOrderByFolder);

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

    const payload = {
        version: 1,
        root: graph.root,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length / 5,
        levels: levels.map((level) => level.slice()),
        depthById: Object.fromEntries(Array.from(depthById.entries())),
        folderOrder: optimized.folderOrder,
        fileOrderByFolder: fileOrderByFolderObj,
        nodeOrderByFileDepth,
        fileMetaByKey: fileMeta
    };
    fs.mkdirSync(path.dirname(outPath) || ".", { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload));
    process.stderr.write(
        `layout: ${levels.length} levels, ${nodes.size} labels, ` +
        `${optimized.folderOrder.length} folders -> ${outPath}\n`
    );
}

main(process.argv.slice(2));
