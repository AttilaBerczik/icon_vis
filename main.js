const ROOT_FILE = "icon.f90";
const ROOT_FUNCTION = "__MAIN__";
const container = d3.select("#visualization");

fetch("callgraph_folders.dot")
    .then((response) => {
        if (!response.ok) {
            throw new Error("Unable to load callgraph.dot");
        }
        return response.text();
    })
    .then((dotText) => {
        const { nodes, edges } = parseDot(dotText);
        let rootId = null;
        for (const [id, label] of nodes.entries()) {
            const labelInfo = parseNodeLabel(label);
            const functionName = labelInfo.lines[labelInfo.lines.length - 1];
            if (labelInfo.file === ROOT_FILE && functionName === ROOT_FUNCTION) {
                rootId = id;
                break;
            }
        }
        if (!rootId) {
            renderError("Could not find icon.f90\\n__MAIN__ in callgraph.dot.");
            return;
        }

        const { levels, depthById } = buildLevels(rootId, edges);
        renderGraph(levels, depthById, nodes, edges);
    })
    .catch((error) => {
        renderError(error.message);
    });

const toggleEdges = document.getElementById("toggle-edges");
if (toggleEdges) {
    toggleEdges.addEventListener("change", (e) => {
        d3.selectAll(".edges").style("display", e.target.checked ? "block" : "none");
    });
}

const toggleBoxes = document.getElementById("toggle-boxes");
if (toggleBoxes) {
    toggleBoxes.addEventListener("change", (e) => {
        d3.selectAll(".file-bounding-boxes").style("display", e.target.checked ? "block" : "none");
    });
}

const toggleFolderBoxes = document.getElementById("toggle-folder-boxes");
if (toggleFolderBoxes) {
    toggleFolderBoxes.addEventListener("change", (e) => {
        d3.selectAll(".folder-bounding-boxes").style("display", e.target.checked ? "block" : "none");
    });
}
