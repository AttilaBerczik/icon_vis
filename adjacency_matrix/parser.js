/**
 * Fetches a DOT file and parses it into nodes and edges arrays
 * using Regular Expressions to safely ignore line breaks.
 */
async function loadAndParseDot(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }
    const dotText = await response.text();

    const nodes = [];
    const edges = [];
    const addedNodes = new Map();

    // 1. Detect all Edges (e.g., node1 -> node25)
    // This finds the source and target regardless of spacing or formatting
    const edgeRegex = /"?([a-zA-Z0-9_]+)"?\s*->\s*"?([a-zA-Z0-9_]+)"?/g;
    let edgeMatch;
    while ((edgeMatch = edgeRegex.exec(dotText)) !== null) {
        const source = edgeMatch[1];
        const target = edgeMatch[2];
        edges.push({ source, target });

        // Add basic nodes to our registry if they haven't been created yet
        [source, target].forEach(id => {
            if (!addedNodes.has(id)) {
                const newNode = { id, name: id, fullName: id, group: 'default' };
                addedNodes.set(id, newNode);
                nodes.push(newNode);
            }
        });
    }

    // 2. Detect all Nodes and their Attributes (e.g., node4 [label="..."])
    // [^\]]+ grabs everything inside the brackets, even if it spans multiple lines!
    const nodeRegex = /"?([a-zA-Z0-9_]+)"?\s*\[([^\]]+)\]/g;
    let nodeMatch;
    while ((nodeMatch = nodeRegex.exec(dotText)) !== null) {
        const id = nodeMatch[1];
        const attrs = nodeMatch[2];

        // Skip global configuration statements like graph [], node [], edge []
        if (id === 'graph' || id === 'node' || id === 'edge') continue;

        // Ensure the node exists in our registry
        if (!addedNodes.has(id)) {
            const newNode = { id, name: id, fullName: id, group: 'default' };
            addedNodes.set(id, newNode);
            nodes.push(newNode);
        }

        const existingNode = addedNodes.get(id);

        // Parse 'label' attribute
        const labelMatch = attrs.match(/label="([^"]+)"/);

        // ONLY update the name if a label was actually found!
        // This prevents edge attributes from overwriting our correct names.
        if (labelMatch) {
            // Replace \n characters with / to create folder/file/function
            const labelStr = labelMatch[1];
            const fullName = labelStr.replace(/\\n|\n/g, '/');
            existingNode.fullName = fullName;
            existingNode.name = fullName;

            // Extract the 'group' (top-level folder) from the label
            //  usually looks like "folder\nfile.f90\nfunction"
            const parts = labelStr.split(/\\n|\n/);
            if (parts.length > 0 && parts[0].trim() !== "") {
                existingNode.group = parts[0].trim();
            }
        }

        // Parse 'group' attribute if it exists (fallback if explicitly defined)
        const groupMatch = attrs.match(/group="([^"]+)"/);
        if (groupMatch) {
            existingNode.group = groupMatch[1];
        }
    }

    return { nodes, edges };
}