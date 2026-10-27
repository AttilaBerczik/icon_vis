// =============================================================================
// dataflow.js — bipartite data flow view for one function ("Data Flow" in a
// side panel tab). Only available for JSON graphs (window.flowData).
//
// Left column: functions. Right column: variables. Both run top to bottom in
// call order: functions in the order they are called, starting from the
// outermost caller; within a function, parameters first, then the variables in
// the source order of the calls they are passed to. A function's box spans its
// own variables (short grey "owns" lines).
//
// A curved edge goes from a variable to every function it is passed into and
// ends at the parameter that receives it; its colour is that parameter's
// intent. Dashed arcs on the right join a variable to a pointer/view on the
// same data (alias). Hovering a variable highlights its whole flow chain.
//
// Clicking a variable switches to the variable trace: that one variable, where
// its data comes from (callers' variables, left) and every callee parameter it
// is passed on to (right), one column per call level.
// =============================================================================

const FLOW_MARGIN = 16;
const FLOW_GROUP_GAP = 10;        // extra space between two functions' blocks
const FLOW_ALIAS_ROOM = 48;       // room right of the variables for alias arcs

// Variables linked to the focus function's own variables by flow/alias edges,
// up to FLOW_VIEW_DEPTH hops downstream (callees) and upstream (callers).
function collectFlowNeighbourhood(focusId, flow) {
    const own = flow.owned.get(focusId) || [];
    const variables = new Set(own);
    const edges = new Set();
    for (const direction of ["out", "in"]) {
        let frontier = own.slice();
        const seen = new Set(frontier);
        for (let depth = 0; depth < FLOW_VIEW_DEPTH && frontier.length; depth++) {
            const next = [];
            for (const v of frontier) {
                for (const e of flow[direction].get(v) || []) {
                    edges.add(e);
                    const other = direction === "out" ? e.target : e.source;
                    variables.add(other);
                    if (!seen.has(other)) {
                        seen.add(other);
                        next.push(other);
                    }
                }
            }
            frontier = next;
        }
    }
    return { variables, edges: Array.from(edges) };
}

// Pre-order walk of the calls between the shown functions, callees in the
// order of their call lines: an approximation of execution order.
function orderFunctionsByCalls(functionIds, flow) {
    const callees = new Map();
    const called = new Set();
    for (const [key, line] of flow.callLine) {
        const [caller, callee] = key.split("|");
        if (caller === callee || !functionIds.has(caller) || !functionIds.has(callee)) continue;
        if (!callees.has(caller)) callees.set(caller, []);
        callees.get(caller).push({ id: callee, line });
        called.add(callee);
    }
    for (const list of callees.values()) {
        list.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
    }

    const order = [];
    const visited = new Set();
    const visit = (id) => {
        if (visited.has(id)) return;
        visited.add(id);
        order.push(id);
        for (const c of callees.get(id) || []) visit(c.id);
    };
    const ids = Array.from(functionIds).sort();
    ids.filter((id) => !called.has(id)).forEach(visit);
    ids.forEach(visit);                       // functions only reachable through a cycle
    return order;
}

// First source line at which a variable is passed on or aliased; params come first.
function variableSortKey(v, flow) {
    const node = flow.variables.get(v);
    const owner = node && node.function ? flow.functions.get(node.function) : null;
    if (node && node.role === "param" && owner) {
        const index = (owner.params || []).findIndex((p) => p.name === node.name);
        return [0, index];
    }
    let first = Infinity;
    for (const e of flow.out.get(v) || []) {
        for (const line of e.lines || []) first = Math.min(first, line);
    }
    return [1, first];
}

function buildFlowLayout(focusId, flow) {
    const { variables, edges } = collectFlowNeighbourhood(focusId, flow);
    const functionIds = new Set();
    const byFunction = new Map();             // function id ("" = module/global) -> [variable id]
    for (const v of variables) {
        const node = flow.variables.get(v);
        if (!node) continue;
        const owner = node.function || "";
        if (owner) functionIds.add(owner);
        if (!byFunction.has(owner)) byFunction.set(owner, []);
        byFunction.get(owner).push(v);
    }

    const groups = [];
    if (byFunction.has("")) groups.push("");  // module/global variables on top
    groups.push(...orderFunctionsByCalls(functionIds, flow));

    const rows = new Map();                   // variable id -> {y, group}
    const blocks = [];                        // {id, y0, y1}
    let y = FLOW_MARGIN;
    for (const group of groups) {
        const vars = (byFunction.get(group) || []).slice();
        vars.sort((a, b) => {
            const ka = variableSortKey(a, flow), kb = variableSortKey(b, flow);
            return ka[0] - kb[0] || ka[1] - kb[1] || a.localeCompare(b);
        });
        const y0 = y;
        for (const v of vars) {
            rows.set(v, { y: y + FLOW_ROW_HEIGHT / 2, group });
            y += FLOW_ROW_HEIGHT;
        }
        blocks.push({ id: group, y0, y1: y, variables: vars });
        y += FLOW_GROUP_GAP;
    }
    return { rows, blocks, edges: edges.filter((e) => rows.has(e.source) && rows.has(e.target)), height: y + FLOW_MARGIN };
}

function truncateText(text, width) {
    const maxChars = Math.max(4, Math.floor((width - 14) / 6.5));
    return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}

function variableTooltip(node) {
    const parts = [node.id, `role: ${node.role}`];
    if (node.intent) parts.push(`intent: ${node.intent}`);
    if (node.type) parts.push(`type: ${node.type}`);
    if (node.gpu_data && node.gpu_data.length) {
        parts.push("GPU: " + Array.from(new Set(node.gpu_data.map((g) => g.action))).join(", "));
    }
    return parts.join("\n");
}

function appendFlowLegend(containerEl) {
    const legend = document.createElement("div");
    legend.className = "dataflow-legend";
    legend.innerHTML =
        Object.entries(FLOW_INTENT_COLORS).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("") +
        `<span class="dataflow-legend-sep"></span>` +
        Object.entries(FLOW_ROLE_COLORS).map(([k, c]) => `<span><b style="background:${c}"></b>${k}</span>`).join("") +
        `<span class="dataflow-legend-sep"></span><span><u></u>alias</span>`;
    containerEl.appendChild(legend);
    return legend;
}

function appendIntentMarkers(svg) {
    const defs = svg.append("defs");
    for (const [intent, color] of Object.entries(FLOW_INTENT_COLORS)) {
        for (const [suffix, orient] of [["end", "auto"], ["start", "auto-start-reverse"]]) {
            defs.append("marker")
                .attr("id", `df-arrow-${intent}-${suffix}`)
                .attr("viewBox", "0 0 8 8").attr("refX", 7).attr("refY", 4)
                .attr("markerWidth", 7).attr("markerHeight", 7).attr("orient", orient)
                .append("path").attr("d", "M0,0 L8,4 L0,8 z").attr("fill", color);
        }
    }
}

// Styling shared by the flow edges of both views.
const flowIntentOf = (e) => (FLOW_INTENT_COLORS[e.intent] ? e.intent : "unknown");

function styleFlowEdges(selection, flow) {
    selection
        .attr("stroke", (e) => FLOW_INTENT_COLORS[flowIntentOf(e)])
        .attr("stroke-width", (e) => Math.min(1.5 + Math.log2(e.weight || 1), 4))
        .attr("marker-end", (e) => (e.intent === "out" ? null : `url(#df-arrow-${flowIntentOf(e)}-end)`))
        .attr("marker-start", (e) => (e.intent === "out" || e.intent === "inout" ? `url(#df-arrow-${flowIntentOf(e)}-start)` : null));
    selection.append("title").text((e) => {
        const lines = e.lines && e.lines.length ? ` (line ${e.lines.join(", ")})` : "";
        return `${e.actual || ""} -> ${flow.variables.get(e.target)?.name || e.target}${lines}\nintent: ${e.intent || "unknown"}` +
            (e.cross_lang ? "\nFortran -> C++" : "");
    });
}

// Everything reachable from start along the edges in map (id -> [id]), start included.
function flowReach(start, map) {
    const seen = new Set([start]);
    const todo = [start];
    while (todo.length) {
        for (const n of map.get(todo.pop()) || []) {
            if (!seen.has(n)) {
                seen.add(n);
                todo.push(n);
            }
        }
    }
    return seen;
}

function adjacency(edges) {
    const succ = new Map(), pred = new Map();
    for (const e of edges) {
        if (!succ.has(e.source)) succ.set(e.source, []);
        if (!pred.has(e.target)) pred.set(e.target, []);
        succ.get(e.source).push(e.target);
        pred.get(e.target).push(e.source);
    }
    return { succ, pred };
}

function renderDataFlowView(focusId, flow, containerEl) {
    containerEl.innerHTML = "";
    const layout = buildFlowLayout(focusId, flow);
    if (!layout.rows.size) {
        d3.select(containerEl).append("div").attr("class", "empty-message")
            .text("No variables or data flow recorded for this function.");
        return;
    }

    appendFlowLegend(containerEl).insertAdjacentHTML("beforeend",
        `<span class="dataflow-legend-sep"></span><span class="dataflow-hint">click a variable to trace it</span>`);

    const scroller = document.createElement("div");
    scroller.className = "dataflow-scroll";
    containerEl.appendChild(scroller);

    const xFunc = FLOW_MARGIN;
    const xFuncRight = xFunc + FLOW_FUNCTION_WIDTH;
    const xVar = xFuncRight + FLOW_COLUMN_GAP;
    const xVarRight = xVar + FLOW_VARIABLE_WIDTH;
    const width = xVarRight + FLOW_ALIAS_ROOM + FLOW_MARGIN;

    const svg = d3.select(scroller).append("svg")
        .attr("class", "dataflow-svg")
        .attr("width", width)
        .attr("height", layout.height);

    appendIntentMarkers(svg);

    const rowY = (v) => layout.rows.get(v).y;
    const flowEdges = layout.edges.filter((e) => e.kind === "flow");
    const aliasEdges = layout.edges.filter((e) => e.kind === "alias");

    // --- edges -----------------------------------------------------------------
    const edgeLayer = svg.append("g").attr("class", "df-edges");

    // owns: function box -> each of its variables
    const ownsData = [];
    for (const block of layout.blocks) {
        if (!block.id) continue;
        for (const v of block.variables) ownsData.push({ fn: block.id, v });
    }
    const owns = edgeLayer.selectAll("line.df-owns").data(ownsData).join("line")
        .attr("class", "df-owns")
        .attr("x1", xFuncRight).attr("x2", xVar)
        .attr("y1", (d) => rowY(d.v)).attr("y2", (d) => rowY(d.v));

    // flow: caller's variable -> callee function, ending at the receiving parameter's row
    const flows = edgeLayer.selectAll("path.df-flow").data(flowEdges).join("path")
        .attr("class", "df-flow")
        .attr("d", (e) => {
            const y1 = rowY(e.source), y2 = rowY(e.target);
            const bend = FLOW_COLUMN_GAP * 0.55;
            return `M${xVar},${y1} C${xVar - bend},${y1} ${xFuncRight + bend},${y2} ${xFuncRight},${y2}`;
        });
    styleFlowEdges(flows, flow);

    // alias: arc right of the variable column
    const aliases = edgeLayer.selectAll("path.df-alias").data(aliasEdges).join("path")
        .attr("class", "df-alias")
        .attr("d", (e) => {
            const y1 = rowY(e.source), y2 = rowY(e.target);
            const reach = Math.min(FLOW_ALIAS_ROOM - 6, 12 + Math.abs(y2 - y1) / 4);
            return `M${xVarRight},${y1} C${xVarRight + reach},${y1} ${xVarRight + reach},${y2} ${xVarRight},${y2}`;
        });
    aliases.append("title").text((e) => `${flow.variables.get(e.target)?.name} refers to the data of ${e.actual}`);

    // --- function column -------------------------------------------------------
    const fnLayer = svg.append("g").attr("class", "df-functions");
    const fnGroups = fnLayer.selectAll("g.df-function").data(layout.blocks).join("g")
        .attr("class", (b) => "df-function" + (b.id === focusId ? " df-focus" : "") + (b.id ? "" : " df-module"))
        .attr("transform", (b) => `translate(${xFunc},${b.y0 + 1})`);
    fnGroups.append("rect")
        .attr("width", FLOW_FUNCTION_WIDTH)
        .attr("height", (b) => Math.max(FLOW_ROW_HEIGHT - 2, b.y1 - b.y0 - 2))
        .attr("rx", 5);
    fnGroups.append("text").attr("class", "df-fn-name")
        .attr("x", 8).attr("y", 14)
        .text((b) => truncateText(b.id ? (flow.functions.get(b.id)?.name || b.id) : "module / global", FLOW_FUNCTION_WIDTH));
    fnGroups.filter((b) => b.y1 - b.y0 >= 2 * FLOW_ROW_HEIGHT).append("text").attr("class", "df-fn-file")
        .attr("x", 8).attr("y", 28)
        .text((b) => truncateText(flow.functions.get(b.id)?.file || "", FLOW_FUNCTION_WIDTH));
    fnGroups.append("title").text((b) => (b.id ? `${b.id}\nclick to open in a side tab` : "module / global variables"));
    fnGroups.filter((b) => b.id && b.id !== focusId)
        .style("cursor", "pointer")
        .on("click", (event, b) => {
            if (window.detailPanelManager) window.detailPanelManager.openTab(b.id);
        });

    // --- variable column -------------------------------------------------------
    const varLayer = svg.append("g").attr("class", "df-variables");
    const varIds = Array.from(layout.rows.keys());
    const varGroups = varLayer.selectAll("g.df-variable").data(varIds).join("g")
        .attr("class", "df-variable")
        .attr("transform", (v) => `translate(${xVar},${rowY(v) - FLOW_ROW_HEIGHT / 2 + 2})`);
    varGroups.append("rect")
        .attr("width", FLOW_VARIABLE_WIDTH).attr("height", FLOW_ROW_HEIGHT - 4).attr("rx", 3);
    varGroups.append("rect").attr("class", "df-role")
        .attr("width", 4).attr("height", FLOW_ROW_HEIGHT - 4)
        .attr("fill", (v) => FLOW_ROLE_COLORS[flow.variables.get(v)?.role] || "#94a3b8");
    varGroups.append("text").attr("class", "df-var-name")
        .attr("x", 10).attr("y", FLOW_ROW_HEIGHT / 2 + 2)
        .text((v) => truncateText(flow.variables.get(v)?.name || v, FLOW_VARIABLE_WIDTH - 40));
    varGroups.append("text").attr("class", "df-var-tag")
        .attr("x", FLOW_VARIABLE_WIDTH - 6).attr("y", FLOW_ROW_HEIGHT / 2 + 2)
        .text((v) => {
            const node = flow.variables.get(v);
            return node?.role === "param" ? (node.intent || "") : (node?.role || "");
        });
    varGroups.append("title").text((v) => variableTooltip(flow.variables.get(v)) + "\nclick to trace this variable");
    varGroups.style("cursor", "pointer")
        .on("click", (event, v) => renderVariableTrace(v, focusId, flow, containerEl));

    // --- highlighting ----------------------------------------------------------
    // A variable's chain: everything reachable along the shown flow/alias edges,
    // forwards and backwards.
    const { succ, pred } = adjacency(layout.edges);

    function highlight(activeVars) {
        svg.classed("df-dimmed", !!activeVars);
        if (!activeVars) {
            svg.selectAll(".df-active").classed("df-active", false);
            return;
        }
        const activeFns = new Set();
        for (const v of activeVars) {
            const owner = flow.variables.get(v)?.function;
            if (owner) activeFns.add(owner);
        }
        for (const e of flowEdges) {
            if (activeVars.has(e.source) && activeVars.has(e.target)) {
                activeFns.add(flow.variables.get(e.target)?.function);
            }
        }
        varGroups.classed("df-active", (v) => activeVars.has(v));
        owns.classed("df-active", (d) => activeVars.has(d.v));
        flows.classed("df-active", (e) => activeVars.has(e.source) && activeVars.has(e.target));
        aliases.classed("df-active", (e) => activeVars.has(e.source) && activeVars.has(e.target));
        fnGroups.classed("df-active", (b) => activeFns.has(b.id));
    }

    varGroups
        .on("mouseenter", (event, v) => {
            const chain = flowReach(v, succ);
            for (const n of flowReach(v, pred)) chain.add(n);
            highlight(chain);
        })
        .on("mouseleave", () => highlight(null));
    fnGroups
        .on("mouseenter", (event, b) => highlight(new Set(b.variables)))
        .on("mouseleave", () => highlight(null));

    // Start with the focused function in view.
    const focusBlock = layout.blocks.find((b) => b.id === focusId);
    if (focusBlock) scroller.scrollTop = Math.max(0, focusBlock.y0 - 40);
}

// =============================================================================
// Variable trace: one variable and how it is passed through the calls.
// =============================================================================

// Column of every variable linked to varId: negative = where the data comes
// from (callers), positive = callee parameters it is passed to. An alias keeps
// the column of its original. Only the variable's own lineage is followed, not
// the other variables an upstream caller passes elsewhere.
function collectVariableTrace(varId, flow) {
    const column = new Map([[varId, 0]]);
    const byLine = (a, b) => Math.min(...(a.lines || [Infinity])) - Math.min(...(b.lines || [Infinity]));
    for (const [direction, step] of [["out", 1], ["in", -1]]) {
        const dist = new Map([[varId, 0]]);
        const queue = [varId];
        while (queue.length) {
            const v = queue.shift();
            const d = dist.get(v);
            for (const e of (flow[direction].get(v) || []).slice().sort(byLine)) {
                const other = direction === "out" ? e.target : e.source;
                const next = d + (e.kind === "alias" ? 0 : step);
                if (Math.abs(next) > FLOW_TRACE_DEPTH) continue;
                if (dist.has(other) && Math.abs(dist.get(other)) <= Math.abs(next)) continue;
                dist.set(other, next);
                if (e.kind === "alias") queue.unshift(other);   // 0-1 BFS: aliases right after their original
                else queue.push(other);
            }
        }
        for (const [v, d] of dist) {
            if (!column.has(v)) column.set(v, d);
        }
    }

    const edges = [];
    for (const v of column.keys()) {
        for (const e of flow.out.get(v) || []) {
            if (column.has(e.target)) edges.push(e);
        }
    }
    return { column, edges };
}

function buildTraceLayout(varId, flow) {
    const { column, edges } = collectVariableTrace(varId, flow);
    const columns = new Map();                 // column index -> [variable id], in discovery order
    for (const [v, c] of column) {
        if (!columns.has(c)) columns.set(c, []);
        columns.get(c).push(v);
    }
    const indices = Array.from(columns.keys()).sort((a, b) => a - b);
    const minColumn = indices[0];
    const maxRows = Math.max(...Array.from(columns.values(), (list) => list.length));
    const rowStep = FLOW_TRACE_NODE_HEIGHT + FLOW_TRACE_NODE_GAP;
    const top = FLOW_MARGIN + 22;              // room for the column titles

    const pos = new Map();                     // variable id -> {x, y} (top left of the box)
    for (const c of indices) {
        const list = columns.get(c);
        const x = FLOW_MARGIN + (c - minColumn) * (FLOW_TRACE_NODE_WIDTH + FLOW_TRACE_COLUMN_GAP);
        const y0 = top + (maxRows - list.length) * rowStep / 2;   // centre short columns
        list.forEach((v, i) => pos.set(v, { x, y: y0 + i * rowStep }));
    }
    return {
        pos, edges, indices, minColumn,
        width: FLOW_MARGIN * 2 + indices.length * FLOW_TRACE_NODE_WIDTH + (indices.length - 1) * FLOW_TRACE_COLUMN_GAP,
        height: top + maxRows * rowStep + FLOW_MARGIN,
    };
}

function traceColumnTitle(c) {
    if (c === 0) return "this variable";
    const n = Math.abs(c);
    return c < 0 ? `from caller${n > 1 ? ` (${n} up)` : ""}` : `passed to callee${n > 1 ? ` (${n} down)` : ""}`;
}

function functionLabel(fnId, flow) {
    if (!fnId) return "module / global";
    return flow.functions.get(fnId)?.name || fnId.split(":").pop();
}

// focusId: the function of the side tab; "back" returns to its bipartite view.
function renderVariableTrace(varId, focusId, flow, containerEl) {
    containerEl.innerHTML = "";

    // --- toolbar: back, variable picker ------------------------------------------
    const bar = document.createElement("div");
    bar.className = "dataflow-trace-bar";
    const back = document.createElement("button");
    back.className = "tab-sub-btn";
    back.textContent = "← All variables";
    back.title = "Back to the functions / variables view";
    back.addEventListener("click", () => renderDataFlowView(focusId, flow, containerEl));
    const label = document.createElement("span");
    label.textContent = "Trace:";
    const picker = document.createElement("select");
    const own = (flow.owned.get(focusId) || []).slice().sort((a, b) => {
        const ka = variableSortKey(a, flow), kb = variableSortKey(b, flow);
        return ka[0] - kb[0] || ka[1] - kb[1] || a.localeCompare(b);
    });
    const choices = own.includes(varId) ? own : [varId, ...own];
    for (const v of choices) {
        const node = flow.variables.get(v);
        const option = document.createElement("option");
        option.value = v;
        option.textContent = node?.function === focusId ? node.name : `${node?.name} (${functionLabel(node?.function, flow)})`;
        option.selected = v === varId;
        picker.appendChild(option);
    }
    picker.addEventListener("change", () => renderVariableTrace(picker.value, focusId, flow, containerEl));
    bar.append(back, label, picker);
    containerEl.appendChild(bar);
    appendFlowLegend(containerEl).insertAdjacentHTML("beforeend",
        `<span class="dataflow-legend-sep"></span><span class="dataflow-hint">click a box to trace that variable</span>`);

    const layout = buildTraceLayout(varId, flow);
    const scroller = document.createElement("div");
    scroller.className = "dataflow-scroll";
    containerEl.appendChild(scroller);
    if (layout.pos.size === 1) {
        d3.select(scroller).append("div").attr("class", "empty-message")
            .text("This variable is not passed to or received from any other function.");
        return;
    }

    const W = FLOW_TRACE_NODE_WIDTH, H = FLOW_TRACE_NODE_HEIGHT;
    const svg = d3.select(scroller).append("svg")
        .attr("class", "dataflow-svg")
        .attr("width", layout.width)
        .attr("height", layout.height);
    appendIntentMarkers(svg);
    const at = (v) => layout.pos.get(v);

    svg.append("g").selectAll("text").data(layout.indices).join("text")
        .attr("class", "df-trace-column")
        .attr("x", (c) => FLOW_MARGIN + (c - layout.minColumn) * (W + FLOW_TRACE_COLUMN_GAP) + W / 2)
        .attr("y", FLOW_MARGIN + 6)
        .text(traceColumnTitle);

    // --- edges -------------------------------------------------------------------
    const edgeLayer = svg.append("g").attr("class", "df-edges");
    const flowEdges = layout.edges.filter((e) => e.kind === "flow");
    const aliasEdges = layout.edges.filter((e) => e.kind === "alias");

    // flow: right side of the caller's variable -> left side of the callee parameter
    const flowPath = (e) => {
        const s = at(e.source), t = at(e.target);
        const x1 = s.x + W, y1 = s.y + H / 2, x2 = t.x, y2 = t.y + H / 2;
        const bend = Math.max(FLOW_TRACE_COLUMN_GAP * 0.5, (x1 - x2) / 2 + 40);   // loops back for recursion
        return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
    };
    const flows = edgeLayer.selectAll("path.df-flow").data(flowEdges).join("path")
        .attr("class", "df-flow")
        .attr("d", flowPath);
    styleFlowEdges(flows, flow);

    // How the value is written at the call, when that is not just the parameter's name.
    const labelled = flowEdges.filter((e) => e.actual && e.actual !== flow.variables.get(e.target)?.name);
    edgeLayer.selectAll("text.df-edge-label").data(labelled).join("text")
        .attr("class", "df-edge-label")
        .attr("x", (e) => at(e.target).x - 6)
        .attr("y", (e) => at(e.target).y + H / 2 - 5)
        .text((e) => truncateText(e.actual, FLOW_TRACE_COLUMN_GAP + 20));

    // alias: arc right of the column (same column) or a dashed curve between columns
    const aliases = edgeLayer.selectAll("path.df-alias").data(aliasEdges).join("path")
        .attr("class", "df-alias")
        .attr("d", (e) => {
            const s = at(e.source), t = at(e.target);
            if (s.x !== t.x) return flowPath(e);
            const x = s.x + W, y1 = s.y + H / 2, y2 = t.y + H / 2;
            const reach = Math.min(FLOW_TRACE_COLUMN_GAP / 2 - 6, 12 + Math.abs(y2 - y1) / 4);
            return `M${x},${y1} C${x + reach},${y1} ${x + reach},${y2} ${x},${y2}`;
        });
    aliases.append("title").text((e) => `${flow.variables.get(e.target)?.name} refers to the data of ${e.actual}`);

    // --- variable boxes ------------------------------------------------------------
    const ids = Array.from(layout.pos.keys());
    const boxes = svg.append("g").attr("class", "df-variables").selectAll("g.df-variable").data(ids).join("g")
        .attr("class", (v) => "df-variable df-trace-node" + (v === varId ? " df-focus" : ""))
        .attr("transform", (v) => `translate(${at(v).x},${at(v).y})`)
        .style("cursor", (v) => (v === varId ? null : "pointer"));
    boxes.append("rect").attr("width", W).attr("height", H).attr("rx", 4);
    boxes.append("rect").attr("class", "df-role")
        .attr("width", 4).attr("height", H)
        .attr("fill", (v) => FLOW_ROLE_COLORS[flow.variables.get(v)?.role] || "#94a3b8");
    boxes.append("text").attr("class", "df-var-name")
        .attr("x", 10).attr("y", 14)
        .text((v) => truncateText(flow.variables.get(v)?.name || v, W - 40));
    boxes.append("text").attr("class", "df-var-tag")
        .attr("x", W - 6).attr("y", 14)
        .text((v) => {
            const node = flow.variables.get(v);
            return node?.role === "param" ? (node.intent || "") : (node?.role || "");
        });
    // second line: function name, then as much of its file as fits (tells
    // same-named Fortran and C++ functions apart)
    const fnName = (v) => truncateText(functionLabel(flow.variables.get(v)?.function, flow), W - 50);
    const fileOf = (v) => (flow.functions.get(flow.variables.get(v)?.function)?.file || "").split("/").pop();
    boxes.append("text").attr("class", "df-fn-file")
        .attr("x", 10).attr("y", 28)
        .text(fnName);
    boxes.append("text").attr("class", "df-fn-file df-var-tag")
        .attr("x", W - 6).attr("y", 28)
        .text((v) => {
            const room = W - 30 - fnName(v).length * 6;
            return room > 40 ? truncateText(fileOf(v), room) : "";
        });
    boxes.append("title").text((v) => {
        const node = flow.variables.get(v);
        return variableTooltip(node) + `\nin ${node?.function || "module / global"}` + (v === varId ? "" : "\nclick to trace this variable");
    });
    boxes.filter((v) => v !== varId)
        .on("click", (event, v) => renderVariableTrace(v, focusId, flow, containerEl));

    // --- highlighting --------------------------------------------------------------
    const { succ, pred } = adjacency(layout.edges);
    function highlight(active) {
        svg.classed("df-dimmed", !!active);
        if (!active) {
            svg.selectAll(".df-active").classed("df-active", false);
            return;
        }
        boxes.classed("df-active", (v) => active.has(v));
        flows.classed("df-active", (e) => active.has(e.source) && active.has(e.target));
        aliases.classed("df-active", (e) => active.has(e.source) && active.has(e.target));
        edgeLayer.selectAll("text.df-edge-label").classed("df-active", (e) => active.has(e.source) && active.has(e.target));
    }
    boxes
        .on("mouseenter", (event, v) => {
            const chain = flowReach(v, succ);
            for (const n of flowReach(v, pred)) chain.add(n);
            highlight(chain);
        })
        .on("mouseleave", () => highlight(null));

    // Start with the selected variable in view.
    const focus = at(varId);
    scroller.scrollLeft = Math.max(0, focus.x - 60);
    scroller.scrollTop = Math.max(0, focus.y - scroller.clientHeight / 2);
}

window.renderDataFlowView = renderDataFlowView;
