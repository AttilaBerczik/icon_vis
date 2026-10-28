/*
 * dataflow.js — main-thread client for the static data-flow index.
 *
 * The heavy files (parameter shards, search index, trace shards) are fetched
 * and parsed inside dataflow-worker.js. This class is a tiny promise wrapper;
 * if Web Workers are unavailable (file:// testing, very old browsers) it falls
 * back to fetching on the main thread.
 */
"use strict";

class DataflowClient {
    constructor(base) {
        this.base = base || "vis/";
        this.worker = null;
        this.workerReady = null;
        this.pending = new Map();
        this.nextId = 1;
        this.fallback = {
            search: null,
            fnShards: new Map(),
            traces: new Map()
        };
    }

    init() {
        if (this.workerReady) return this.workerReady;
        this.workerReady = new Promise((resolve) => {
            try {
                this.worker = new Worker("dataflow-worker.js");
                this.worker.onmessage = (event) => this._onMessage(event.data);
                this.worker.onerror = () => {
                    this.worker = null;
                    for (const [, waiter] of this.pending) {
                        waiter.reject(new Error("dataflow worker crashed"));
                    }
                    this.pending.clear();
                    resolve(false);
                };
                this.worker.postMessage({ id: 0, type: "init", payload: { base: this.base } });
                resolve(true);
            } catch (err) {
                this.worker = null;
                resolve(false);
            }
        });
        return this.workerReady;
    }

    _onMessage(msg) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.ok) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error || "dataflow worker error"));
    }

    _request(type, payload) {
        return this.init().then((hasWorker) => {
            if (!hasWorker || !this.worker) return this._fallback(type, payload);
            const id = this.nextId++;
            return new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                this.worker.postMessage({ id, type, payload });
            });
        });
    }

    async _fetchJson(relPath) {
        const res = await fetch(this.base + relPath, { cache: "force-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
        return res.json();
    }

    async _fallback(type, payload) {
        if (type === "search") {
            if (!this.fallback.search) this.fallback.search = await this._fetchJson("search.json");
            const data = this.fallback.search;
            const q = String(payload.query || "").toLowerCase().trim();
            if (!q) return [];
            let lo = 0, hi = data.names.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (data.names[mid] < q) lo = mid + 1; else hi = mid;
            }
            const out = [];
            const seen = new Set();
            for (let i = lo; i < data.names.length; i += 1) {
                const name = data.names[i];
                if (!name.startsWith(q)) break;
                const gid = data.groups[i];
                if (seen.has(gid)) continue;
                seen.add(gid);
                out.push({
                    name, groupId: gid,
                    kind: ["field", "param", "var"][data.kinds[i]] || "other",
                    reads: data.reads[i], writes: data.writes[i]
                });
                if (out.length >= (payload.limit || 50)) break;
            }
            return out;
        }
        if (type === "getParams") {
            const shard = payload.shard;
            if (!shard) return null;
            if (!this.fallback.fnShards.has(shard)) {
                this.fallback.fnShards.set(shard, await this._fetchJson(shard));
            }
            return (this.fallback.fnShards.get(shard).functions || {})[payload.fnId] || null;
        }
        if (type === "getTrace") {
            const gid = payload.groupId;
            if (!gid) return null;
            const shard = gid.slice(0, 2);
            let data = this.fallback.traces.get(shard);
            if (!data) {
                data = await this._fetchJson(`trace/${shard}.json`);
                this.fallback.traces.set(shard, data);
            }
            return (data.groups || {})[gid] || null;
        }
        if (type === "prefetchParams") {
            for (const shard of payload.shards || []) {
                if (!shard || this.fallback.fnShards.has(shard)) continue;
                try {
                    this.fallback.fnShards.set(shard, await this._fetchJson(shard));
                } catch (err) { /* optional */ }
            }
            return true;
        }
        return null;
    }

    search(query, limit) {
        return this._request("search", { query, limit: limit || 50 });
    }

    getParams(fnId, shard) {
        return this._request("getParams", { fnId, shard });
    }

    getTrace(groupId) {
        return this._request("getTrace", { groupId });
    }

    prefetchParams(shards) {
        return this._request("prefetchParams", { shards }).catch(() => null);
    }
}

// --------------------------------------------------------------------------
// Trace view model
// --------------------------------------------------------------------------

const TRACE_ROLE = { CREATE: 1, WRITE: 2, READ: 4, PASS: 8 };

function dataTraceRoleNames(mask) {
    const names = [];
    if (mask & TRACE_ROLE.CREATE) names.push("create");
    if (mask & TRACE_ROLE.WRITE) names.push("write");
    if (mask & TRACE_ROLE.READ) names.push("read");
    if (mask & TRACE_ROLE.PASS) names.push("pass");
    return names;
}

/**
 * Convert a precomputed trace record into the small shape render.js consumes.
 * mode: "backward" (one parameter chain) or "full" (all events).
 */
function buildDataTraceView(trace, mode, paramEntity) {
    const nodeIds = new Set();
    const roles = new Map();
    const edges = new Set();
    const steps = new Map();
    const nodeEvents = new Map();
    let originFn = trace.origin && trace.origin.node;
    let originFile = trace.origin && trace.origin.file;
    let originName = trace.origin && trace.origin.name;
    let originLine = trace.origin && trace.origin.line;

    const addRole = (fn, mask) => {
        if (fn === null || fn === undefined || fn < 0) return;
        nodeIds.add(fn);
        roles.set(fn, (roles.get(fn) || 0) | mask);
    };
    const addEvent = (fn, event) => {
        if (!nodeEvents.has(fn)) nodeEvents.set(fn, []);
        nodeEvents.get(fn).push(event);
    };

    if (mode === "backward" && paramEntity && trace.backward && trace.backward[paramEntity]) {
        const chain = trace.backward[paramEntity];
        chain.forEach((step, index) => {
            const fn = step[0];
            const upstream = step[4];
            const role = step[2] || TRACE_ROLE.PASS;
            addRole(fn, role);
            if (index === chain.length - 1) addRole(fn, TRACE_ROLE.CREATE);
            if (!steps.has(fn)) steps.set(fn, index + 1);
            addEvent(fn, { line: step[1], role, entity: step[3], upstream });
            if (upstream !== null && upstream !== undefined && upstream >= 0) {
                edges.add(`${upstream}|${fn}`);
            }
        });
        const last = chain[chain.length - 1];
        if (last && last[0] !== undefined) originFn = last[0];
        originFile = last ? last[5] : (trace.origin && trace.origin.file);
        originLine = last ? last[1] : (trace.origin && trace.origin.line);
    } else {
        for (const ev of trace.events || []) {
            const fn = ev[0];
            const role = ev[2];
            const other = ev[5];
            addRole(fn, role);
            addEvent(fn, { line: ev[1], role, entity: ev[4], via: ev[3] });
            if (other !== undefined && other >= 0) {
                addRole(other, TRACE_ROLE.PASS);
                addEvent(other, { line: ev[1], role: TRACE_ROLE.PASS, entity: ev[6] });
            }
            if ((role & TRACE_ROLE.PASS) && other !== undefined && other >= 0) {
                edges.add(`${fn}|${other}`);
            }
        }
        if (originFn === undefined || originFn === null) {
            originFn = [...nodeIds][0];
        }
    }

    const folderCounts = new Map(trace.folders || []);
    const fileCounts = new Map(trace.files || []);
    return {
        trace,
        mode,
        paramEntity: paramEntity || null,
        nodeIds,
        roles,
        edges,
        steps,
        nodeEvents,
        originFn,
        originFile,
        originName,
        originLine,
        counts: trace.counts || {},
        folderCounts,
        fileCounts,
        large: nodeIds.size > 500,
        entity: trace.entity,
        kind: trace.kind
    };
}

function formatIntent(intent) {
    if (!intent) return "—";
    const v = String(intent).toLowerCase();
    if (v === "in") return "IN";
    if (v === "out") return "OUT";
    if (v === "inout") return "INOUT";
    return String(intent).toUpperCase();
}

function intentMismatch(param) {
    const declared = (param.i || "").toLowerCase();
    const inferred = (param.ii || "").toLowerCase();
    if (!declared || !inferred || inferred === "none") return false;
    if (declared === "inout") return false;
    return declared !== inferred;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        DataflowClient,
        buildDataTraceView,
        dataTraceRoleNames,
        formatIntent,
        intentMismatch,
        TRACE_ROLE
    };
}
