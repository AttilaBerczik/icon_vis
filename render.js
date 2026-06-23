function renderGraph(levels, depthById, nodes, edges) {
    container.selectAll("*").remove();

    const nodeData = [];
    const basePaddingX = 16; // 8px left + 8px right padding
    const basePaddingY = 12; // 6px top + 6px bottom padding
    const charWidthEstimate = 6.5; // Slightly tighter estimate for a 12px font
    const lineHeight = 16;

    // 1. Process node data and compute individual dimensions per node
    levels.forEach((levelIds, depth) => {
        levelIds.forEach((id) => {
            const rawLabel = nodes.get(id) || id;
            const labelInfo = parseNodeLabel(rawLabel);
            const lines = labelInfo.lines;

            // Find max length just for *this* node's text
            let localMaxLineLength = 0;
            lines.forEach((line) => {
                localMaxLineLength = Math.max(localMaxLineLength, line.length);
            });

            // Calculate tight width and height for this specific node
            // Removed the massive 140px / 42px minimum limits
            const calculatedWidth = Math.max(32, localMaxLineLength * charWidthEstimate + basePaddingX);
            const calculatedHeight = Math.max(24, lines.length * lineHeight + basePaddingY);

            nodeData.push({
                id,
                depth,
                rawLabel,
                lines,
                width: calculatedWidth,
                height: calculatedHeight,
                folder: labelInfo.folder,
                file: labelInfo.file,
                fileKey: makeFileKey(labelInfo.folder, labelInfo.file)
            });
        });
    });

    // Create a quick lookup map for individual node dimensions
    const nodeDims = new Map(nodeData.map(d => [d.id, { w: d.width, h: d.height }]));

    // Layout configuration spacing
    const xSpacingBetweenNodes = 30; // Slightly tighter space between the narrower nodes
    const ySpacing = 120;
    const margin = { top: 40, right: 40, bottom: 40, left: 40 };

    const { folderOrder, fileOrderByFolder, fileMetaByKey } = buildFolderFileIndex(levels, nodes);
    const { folderOrder: orderedFolders, fileOrderByFolder: orderedFilesByFolder, nodeOrderByFileDepth } =
        optimizeLayout(levels, depthById, nodes, edges, folderOrder, fileOrderByFolder);
    const fileOrder = flattenFileOrder(orderedFolders, orderedFilesByFolder);

    // 2. Compute maximum column widths per file column based on its widest individual node
    const maxNodesPerLevelByFile = new Map();
    const fileColumnWidths = new Map();

    fileOrder.forEach((f) => {
        maxNodesPerLevelByFile.set(f, 0);
        fileColumnWidths.set(f, 0);
    });

    levels.forEach((levelIds) => {
        const counts = new Map();
        const maxNodeWidthInFileForLevel = new Map();

        levelIds.forEach((id) => {
            const fileKey = getNodeFileKey(id, nodes);
            counts.set(fileKey, (counts.get(fileKey) || 0) + 1);

            const dims = nodeDims.get(id);
            if (dims) {
                const currentMax = maxNodeWidthInFileForLevel.get(fileKey) || 0;
                maxNodeWidthInFileForLevel.set(fileKey, Math.max(currentMax, dims.w));
            }
        });

        for (const [f, c] of counts.entries()) {
            maxNodesPerLevelByFile.set(f, Math.max(maxNodesPerLevelByFile.get(f) || 0, c));

            // Default fallback width is now 32 instead of 140
            const levelNodeWidth = maxNodeWidthInFileForLevel.get(f) || 32;
            const totalLevelWidthNeeded = c * levelNodeWidth + (c - 1) * xSpacingBetweenNodes;
            fileColumnWidths.set(f, Math.max(fileColumnWidths.get(f) || 0, totalLevelWidthNeeded));
        }
    });

    // 3. Calculate file X start boundaries dynamically
    const fileStartX = new Map();
    let currentX = margin.left;
    orderedFolders.forEach((folder) => {
        const files = orderedFilesByFolder.get(folder) || [];
        files.forEach((f) => {
            fileStartX.set(f, currentX);
            const colWidth = fileColumnWidths.get(f) + 40; // Structural padding between files
            currentX += colWidth;
        });
    });

    const svgWidth = Math.max(900, currentX + margin.right);
    // Find absolute max height dynamic calculation
    let maxIndividualHeight = 24;
    nodeData.forEach(d => { if (d.height > maxIndividualHeight) maxIndividualHeight = d.height; });
    const svgHeight = margin.top + margin.bottom + (levels.length - 1) * ySpacing + maxIndividualHeight;

    const positions = new Map();

    // 4. Calculate positions balancing variables sizes
    levels.forEach((_, depth) => {
        orderedFolders.forEach((folder) => {
            const files = orderedFilesByFolder.get(folder) || [];
            files.forEach((f) => {
                const depthMap = nodeOrderByFileDepth.get(f);
                const ids = depthMap ? depthMap.get(depth) : null;
                if (!ids || ids.length === 0) return;

                const startX = fileStartX.get(f);
                const totalColWidth = fileColumnWidths.get(f);
                const colCenter = startX + totalColWidth / 2;

                const K = ids.length;
                let totalSubsegmentWidth = 0;
                ids.forEach((id) => { totalSubsegmentWidth += nodeDims.get(id).w; });
                totalSubsegmentWidth += (K - 1) * xSpacingBetweenNodes;

                let segmentStartX = colCenter - totalSubsegmentWidth / 2;

                ids.forEach((id) => {
                    const dims = nodeDims.get(id);
                    const x = segmentStartX + dims.w / 2;
                    const y = margin.top + dims.h / 2 + depth * ySpacing;
                    positions.set(id, { x, y });

                    segmentStartX += dims.w + xSpacingBetweenNodes;
                });
            });
        });
    });

    // 5. Generate links
    const linkData = [];
    for (const [from, targets] of edges.entries()) {
        const fromDepth = depthById.get(from);
        if (fromDepth === undefined || fromDepth >= MAX_DEPTH) continue;
        const sourcePos = positions.get(from);
        if (!sourcePos) continue;

        for (const target of targets) {
            if (depthById.get(target) !== fromDepth + 1) continue;
            const targetPos = positions.get(target);
            if (!targetPos) continue;
            linkData.push({ source: sourcePos, target: targetPos, fromId: from, toId: target });
        }
    }

    const svg = container
        .append("svg")
        .attr("width", svgWidth)
        .attr("height", svgHeight);

    // 6. Compute accurate bounding boxes using distinct dimensions per node
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
            fileBox.minX = Math.min(fileBox.minX, pos.x - d.width / 2);
            fileBox.maxX = Math.max(fileBox.maxX, pos.x + d.width / 2);
            fileBox.minY = Math.min(fileBox.minY, pos.y - d.height / 2);
            fileBox.maxY = Math.max(fileBox.maxY, pos.y + d.height / 2);
        }

        const folderBox = folderBoxes.get(d.folder);
        if (folderBox) {
            folderBox.active = true;
            folderBox.minX = Math.min(folderBox.minX, pos.x - d.width / 2);
            folderBox.maxX = Math.max(folderBox.maxX, pos.x + d.width / 2);
            folderBox.minY = Math.min(folderBox.minY, pos.y - d.height / 2);
            folderBox.maxY = Math.max(folderBox.maxY, pos.y + d.height / 2);
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

    // Render folder boxes
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

    // Render file boxes
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

    // Render baseline depth dividers
    svg.append("g").attr("class", "level-lines")
        .selectAll("line")
        .data(levels)
        .enter()
        .append("line")
        .attr("x1", margin.left)
        .attr("x2", svgWidth - margin.right)
        .attr("y1", (_, depth) => margin.top + maxIndividualHeight / 2 + depth * ySpacing)
        .attr("y2", (_, depth) => margin.top + maxIndividualHeight / 2 + depth * ySpacing)
        .attr("stroke", "#e2e8f0")
        .attr("stroke-width", 1);

    // 7. Dynamic link connection math (pulling top/bottom dynamically from distinct source/target heights)
    svg.append("g").attr("class", "edges")
        .selectAll("line")
        .data(linkData)
        .enter()
        .append("line")
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y + (nodeDims.get(d.fromId).h / 2))
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y - (nodeDims.get(d.toId).h / 2))
        .attr("stroke", "#94a3b8")
        .attr("stroke-width", 1);

    // 8. Render unique grouped node sizes
    const nodeGroups = svg
        .append("g").attr("class", "nodes")
        .selectAll("g")
        .data(nodeData)
        .enter()
        .append("g")
        .attr("transform", (d) => {
            const position = positions.get(d.id);
            return `translate(${position.x - d.width / 2}, ${position.y - d.height / 2})`;
        });

    nodeGroups
        .append("rect")
        .attr("width", (d) => d.width)
        .attr("height", (d) => d.height)
        .attr("rx", 6) // Made slightly rounder to match the smaller boxes
        .attr("fill", (d) => (d.depth === 0 ? "#2563eb" : "#e2e8f0"))
        .attr("stroke", "#94a3b8");

    nodeGroups
        .append("text")
        .attr("x", (d) => d.width / 2)
        .attr("y", (d) => d.height / 2 - (d.lines.length - 1) * 8)
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .attr("fill", (d) => (d.depth === 0 ? "#f8fafc" : "#1f2937"))
        .selectAll("tspan")
        .data((d) => d.lines.map(line => ({ line, width: d.width, lineCount: d.lines.length })))
        .enter()
        .append("tspan")
        .attr("x", (d) => d.width / 2)
        .attr("dy", (_, i) => (i === 0 ? 0 : 16))
        .text((d) => d.line);
}

function renderError(message) {
    container.selectAll("*").remove();
    container
        .append("div")
        .style("color", "#b91c1c")
        .style("font-weight", "600")
        .text(message);
}