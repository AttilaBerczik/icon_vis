function renderGraph(levels, depthById, nodes, edges) {
    container.selectAll("*").remove();

    const nodeData = [];
    let maxLineLength = 0;
    let maxLines = 1;

    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const labelInfo = parseNodeLabel(rawLabel);
            const lines = labelInfo.lines;
            lines.forEach((line) => {
                maxLineLength = Math.max(maxLineLength, line.length);
            });
            maxLines = Math.max(maxLines, lines.length);
            nodeData.push({
                id,
                depth,
                rawLabel,
                lines,
                folder: labelInfo.folder,
                file: labelInfo.file,
                fileKey: makeFileKey(labelInfo.folder, labelInfo.file)
            });
        });
    });

    const nodeWidth = Math.max(200, maxLineLength * 7 + 24);
    const nodeHeight = Math.max(42, maxLines * 16 + 18);
    const xSpacing = nodeWidth + 40;
    const ySpacing = nodeHeight + 70;
    const margin = { top: 30, right: 30, bottom: 30, left: 30 };
    const { folderOrder, fileOrderByFolder, fileMetaByKey } = buildFolderFileIndex(levels, nodes);
    const { folderOrder: orderedFolders, fileOrderByFolder: orderedFilesByFolder, nodeOrderByFileDepth } =
        optimizeLayout(levels, depthById, nodes, edges, folderOrder, fileOrderByFolder);
    const fileOrder = flattenFileOrder(orderedFolders, orderedFilesByFolder);
    const maxNodesPerLevelByFile = new Map();
    fileOrder.forEach((f) => maxNodesPerLevelByFile.set(f, 0));

    levels.forEach((levelIds) => {
        const counts = new Map();
        levelIds.forEach((id) => {
            const fileKey = getNodeFileKey(id, nodes);
            counts.set(fileKey, (counts.get(fileKey) || 0) + 1);
        });
        for (const [f, c] of counts.entries()) {
            if (!maxNodesPerLevelByFile.has(f)) {
                maxNodesPerLevelByFile.set(f, 0);
            }
            if (c > maxNodesPerLevelByFile.get(f)) {
                maxNodesPerLevelByFile.set(f, c);
            }
        }
    });

    const fileStartX = new Map();
    let currentX = margin.left;
    orderedFolders.forEach((folder) => {
        const files = orderedFilesByFolder.get(folder) || [];
        files.forEach((f) => {
            fileStartX.set(f, currentX);
            const colWidth = maxNodesPerLevelByFile.get(f) * xSpacing;
            currentX += colWidth;
        });
    });

    const svgWidth = Math.max(900, currentX + margin.right);
    const svgHeight =
        margin.top + margin.bottom + (levels.length - 1) * ySpacing + nodeHeight;

    const positions = new Map();

    levels.forEach((_, depth) => {
        orderedFolders.forEach((folder) => {
            const files = orderedFilesByFolder.get(folder) || [];
            files.forEach((f) => {
                const depthMap = nodeOrderByFileDepth.get(f);
                const ids = depthMap ? depthMap.get(depth) : null;
                if (!ids || ids.length === 0) {
                    return;
                }
                const startX = fileStartX.get(f);
                const N = maxNodesPerLevelByFile.get(f);
                const K = ids.length;

                const colCenter = startX + N * xSpacing / 2;
                const firstNodeCenterX = colCenter - (K - 1) * xSpacing / 2;

                ids.forEach((id, index) => {
                    const x = firstNodeCenterX + index * xSpacing;
                    const y = margin.top + nodeHeight / 2 + depth * ySpacing;
                    positions.set(id, { x, y });
                });
            });
        });
    });

    const linkData = [];
    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= MAX_DEPTH) {
            continue;
        }
        const sourcePos = positions.get(from);
        if (!sourcePos) {
            continue;
        }
        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) {
                continue;
            }
            const targetPos = positions.get(target);
            if (!targetPos) {
                continue;
            }
            linkData.push({ source: sourcePos, target: targetPos });
        }
    }

    const svg = container
        .append("svg")
        .attr("width", svgWidth)
        .attr("height", svgHeight);

    // Compute and draw bounding boxes
    const fileBoxes = new Map();
    fileOrder.forEach((f) => {
        fileBoxes.set(f, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, active: false });
    });
    const folderBoxes = new Map();
    orderedFolders.forEach((folder) => {
        folderBoxes.set(folder, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, active: false });
    });

    nodeData.forEach((d) => {
        const pos = positions.get(d.id);
        const fileBox = fileBoxes.get(d.fileKey);
        if (fileBox) {
            fileBox.active = true;
            fileBox.minX = Math.min(fileBox.minX, pos.x - nodeWidth / 2);
            fileBox.maxX = Math.max(fileBox.maxX, pos.x + nodeWidth / 2);
            fileBox.minY = Math.min(fileBox.minY, pos.y - nodeHeight / 2);
            fileBox.maxY = Math.max(fileBox.maxY, pos.y + nodeHeight / 2);
        }

        const folderBox = folderBoxes.get(d.folder);
        if (folderBox) {
            folderBox.active = true;
            folderBox.minX = Math.min(folderBox.minX, pos.x - nodeWidth / 2);
            folderBox.maxX = Math.max(folderBox.maxX, pos.x + nodeWidth / 2);
            folderBox.minY = Math.min(folderBox.minY, pos.y - nodeHeight / 2);
            folderBox.maxY = Math.max(folderBox.maxY, pos.y + nodeHeight / 2);
        }
    });

    const boxPadding = 20;
    const fileBoxData = [];
    const folderBoxData = [];
    const fileColorScale = d3.scaleOrdinal(d3.schemeCategory10);
    const folderColorScale = d3.scaleOrdinal(d3.schemeSet3);

    orderedFolders.forEach((folder, i) => {
        const box = folderBoxes.get(folder);
        if (box.active) {
            folderBoxData.push({
                folder,
                x: box.minX - boxPadding,
                y: box.minY - boxPadding,
                width: box.maxX - box.minX + 2 * boxPadding,
                height: box.maxY - box.minY + 2 * boxPadding,
                color: folderColorScale(i)
            });
        }
    });

    fileOrder.forEach((f, i) => {
        const box = fileBoxes.get(f);
        if (box.active) {
            const meta = fileMetaByKey.get(f);
            const label = meta && meta.file ? meta.file : f;
            fileBoxData.push({
                file: f,
                label,
                x: box.minX - boxPadding,
                y: box.minY - boxPadding,
                width: box.maxX - box.minX + 2 * boxPadding,
                height: box.maxY - box.minY + 2 * boxPadding,
                color: fileColorScale(i)
            });
        }
    });

    const folderBoxesGroup = svg.append("g").attr("class", "folder-bounding-boxes");
    folderBoxesGroup.selectAll("rect")
        .data(folderBoxData)
        .enter()
        .append("rect")
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y)
        .attr("width", (d) => d.width)
        .attr("height", (d) => d.height)
        .attr("fill", (d) => d.color)
        .attr("fill-opacity", 0.05)
        .attr("stroke", (d) => d.color)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "8,4")
        .attr("rx", 12);

    folderBoxesGroup.selectAll("text.folder-box-label")
        .data(folderBoxData)
        .enter()
        .append("text")
        .attr("class", "folder-box-label")
        .attr("x", (d) => d.x + 10)
        .attr("y", (d) => d.y + 20)
        .attr("fill", (d) => d.color)
        .style("font-weight", "bold")
        .style("font-size", "14px")
        .text((d) => d.folder);

    const fileBoxesGroup = svg.append("g").attr("class", "file-bounding-boxes");
    fileBoxesGroup.selectAll("rect")
        .data(fileBoxData)
        .enter()
        .append("rect")
        .attr("x", (d) => d.x)
        .attr("y", (d) => d.y)
        .attr("width", (d) => d.width)
        .attr("height", (d) => d.height)
        .attr("fill", (d) => d.color)
        .attr("fill-opacity", 0.08)
        .attr("stroke", (d) => d.color)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "5,5")
        .attr("rx", 10);

    fileBoxesGroup.selectAll("text.file-box-label")
        .data(fileBoxData)
        .enter()
        .append("text")
        .attr("class", "file-box-label")
        .attr("x", (d) => d.x + 10)
        .attr("y", (d) => d.y + 34)
        .attr("fill", (d) => d.color)
        .style("font-weight", "bold")
        .style("font-size", "12px")
        .text((d) => d.label);

    svg.append("g").attr("class", "level-lines")
        .selectAll("line")
        .data(levels)
        .enter()
        .append("line")
        .attr("x1", margin.left)
        .attr("x2", svgWidth - margin.right)
        .attr(
            "y1",
            (_, depth) => margin.top + nodeHeight / 2 + depth * ySpacing
        )
        .attr(
            "y2",
            (_, depth) => margin.top + nodeHeight / 2 + depth * ySpacing
        )
        .attr("stroke", "#e2e8f0")
        .attr("stroke-width", 1);

    svg.append("g").attr("class", "edges")
        .selectAll("line")
        .data(linkData)
        .enter()
        .append("line")
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y + nodeHeight / 2)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y - nodeHeight / 2)
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 1);

    const nodeGroups = svg
        .append("g").attr("class", "nodes")
        .selectAll("g")
        .data(nodeData)
        .enter()
        .append("g")
        .attr("transform", (d) => {
            const position = positions.get(d.id);
            return `translate(${position.x - nodeWidth / 2}, ${
                position.y - nodeHeight / 2
            })`;
        });

    nodeGroups
        .append("rect")
        .attr("width", nodeWidth)
        .attr("height", nodeHeight)
        .attr("rx", 8)
        .attr("fill", (d) => (d.depth === 0 ? "#2563eb" : "#e2e8f0"))
        .attr("stroke", "#94a3b8");

    nodeGroups
        .append("text")
        .attr("x", nodeWidth / 2)
        .attr("y", nodeHeight / 2 - (maxLines - 1) * 8)
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .attr("fill", (d) => (d.depth === 0 ? "#f8fafc" : "#1f2937"))
        .selectAll("tspan")
        .data((d) => d.lines)
        .enter()
        .append("tspan")
        .attr("x", nodeWidth / 2)
        .attr("dy", (_, i) => (i === 0 ? 0 : 16))
        .text((d) => d);
}

function renderError(message) {
    container.selectAll("*").remove();
    container
        .append("div")
        .style("color", "#b91c1c")
        .style("font-weight", "600")
        .text(message);
}
