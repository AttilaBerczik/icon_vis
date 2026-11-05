/*
 * dataflow.js — main-thread client for the static data-flow index.
 *
 * The heavy files (parameter shards, search index, trace shards) are fetched
 * and parsed inside dataflow-worker.js. This class is a tiny promise wrapper;
 * if Web Workers are unavailable (file:// testing, very old browsers) it falls
 * back to fetching on the main thread.
 */
"use strict";

// A Worker can be created successfully and still never run a single message:
// extensions such as JShelter replace `window.Worker` with a stub (and log
// "Permission denied to access object" while doing it), sandboxed pages and
// strict policies can block worker scripts, and a crashed worker stays silent.
// Waiting on such a worker forever left the parameter card on "Loading
// parameters…", so requests have deadlines and the main-thread fallback is used
// whenever the worker does not answer.
const WORKER_FIRST_REQUEST_TIMEOUT_MS = 5000;
const WORKER_REQUEST_TIMEOUT_MS = 15000;
// Give a freshly created worker time to boot before checking whether it answered.
const WORKER_LIVENESS_DELAY_MS = 1500;

class DataflowClient {
    constructor(base) {
        this.base = base || "vis/";
        this.worker = null;
        this.workerReady = null;
        this.workerDisabled = false;
        // True once the worker has sent at least one message. A worker that
        // never answers is dead even though `new Worker` succeeded.
        this.workerAlive = false;
        this.pending = new Map();
        this.nextId = 1;
        this.fallback = {
            search: null,
            fnShards: new Map(),
            traces: new Map(),
            structs: null,
            structShards: new Map()
        };
    }

    init() {
        if (this.workerReady) return this.workerReady;
        this.workerReady = new Promise((resolve) => {
            let worker;
            try {
                worker = new Worker("dataflow-worker.js");
            } catch (err) {
                this.workerDisabled = true;
                resolve(false);
                return;
            }

            this.worker = worker;
            worker.onmessage = (event) => {
                this.workerAlive = true;
                const msg = event.data || {};
                if (msg.id !== 0) this._onMessage(msg);
            };
            worker.onerror = (event) => {
                const message = event && event.message ? event.message : "dataflow worker crashed";
                this._disableWorker(new Error(message));
            };
            worker.onmessageerror = () => {
                this._disableWorker(new Error("dataflow worker message could not be deserialized"));
            };

            try {
                worker.postMessage({ id: 0, type: "init", payload: { base: this.base } });
            } catch (err) {
                this._disableWorker(err);
                resolve(false);
                return;
            }

            // Do not use a plain wall-clock timer here: the first layout blocks
            // the main thread, and a queued worker reply is only processed after
            // that block. An idle callback is queued behind the reply, so a live
            // worker has always answered by the time this runs.
            const probe = () => {
                if (this.workerAlive || this.workerDisabled) return;
                setTimeout(() => {
                    if (!this.workerAlive && !this.workerDisabled) {
                        this._disableWorker(new Error("dataflow worker did not respond"));
                    }
                }, WORKER_LIVENESS_DELAY_MS);
            };
            if (typeof requestIdleCallback === "function") {
                requestIdleCallback(probe, { timeout: 8000 });
            } else {
                setTimeout(probe, WORKER_LIVENESS_DELAY_MS + 2000);
            }

            resolve(true);
        });
        return this.workerReady;
    }

    // Stop using the worker and serve everything that was waiting (plus all
    // future requests) from the main thread.
    _disableWorker(err) {
        if (this.workerDisabled) return;
        this.workerDisabled = true;
        this.workerAlive = false;
        const worker = this.worker;
        this.worker = null;
        if (worker) {
            try { worker.terminate(); } catch (ignored) { /* already gone */ }
        }
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const waiter of pending) {
            clearTimeout(waiter.timer);
            this._fallback(waiter.type, waiter.payload).then(waiter.resolve, waiter.reject);
        }
        if (err && typeof console !== "undefined") {
            console.warn("dataflow worker unavailable, loading on the main thread:", err.message || err);
        }
    }

    _onMessage(msg) {
        if (!msg) return;
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        if (msg.ok) waiter.resolve(msg.result);
        else waiter.reject(new Error(msg.error || "dataflow worker error"));
    }

    _request(type, payload) {
        return this.init().then((hasWorker) => {
            if (!hasWorker || !this.worker || this.workerDisabled) return this._fallback(type, payload);
            const worker = this.worker;
            const id = this.nextId++;
            return new Promise((resolve, reject) => {
                let settled = false;
                const waiter = {
                    type,
                    payload,
                    resolve: (value) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(waiter.timer);
                        this.pending.delete(id);
                        resolve(value);
                    },
                    reject: (error) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(waiter.timer);
                        this.pending.delete(id);
                        reject(error);
                    }
                };
                waiter.timer = setTimeout(() => {
                    if (!this.workerAlive) {
                        // Nothing was ever received: the worker is a stub. Drop
                        // it and retry every pending request on the main thread.
                        this._disableWorker(new Error(`dataflow worker did not answer ${type}`));
                        return;
                    }
                    // A worker that has answered before is merely slow (or the
                    // page was busy). Serve this one request on the main thread
                    // without tearing the worker down.
                    this.pending.delete(id);
                    this._fallback(type, payload).then(waiter.resolve, waiter.reject);
                }, this.workerAlive ? WORKER_REQUEST_TIMEOUT_MS : WORKER_FIRST_REQUEST_TIMEOUT_MS);
                this.pending.set(id, waiter);
                try {
                    worker.postMessage({ id, type, payload });
                } catch (err) {
                    this._disableWorker(err);
                }
            });
        });
    }

    async _fetchJson(relPath, cacheMode) {
        const res = await fetch(this.base + relPath, { cache: cacheMode || "force-cache" });
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
            const max = Math.max(1, Math.min(payload.limit || 50, 100));
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
                    kind: ["field", "param", "var", "struct", "local"][data.kinds[i]] || "other",
                    reads: data.reads[i], writes: data.writes[i],
                    type: (data.types && data.types[i]) || "",
                    member: (data.members && data.members[i]) || "",
                    fns: (data.fns && data.fns[i]) || 0
                });
                if (out.length >= max * 2) break;
            }
            const kindOrder = { struct: 0, field: 1, var: 2, param: 3, local: 4 };
            out.sort((a, b) => {
                const aExact = a.name === q ? 0 : (a.name.endsWith("%" + q) ? 1 : 2);
                const bExact = b.name === q ? 0 : (b.name.endsWith("%" + q) ? 1 : 2);
                if (aExact !== bExact) return aExact - bExact;
                const aKind = kindOrder[a.kind] ?? 9;
                const bKind = kindOrder[b.kind] ?? 9;
                if (aKind !== bKind) return aKind - bKind;
                const aSize = (a.reads || 0) + (a.writes || 0);
                const bSize = (b.reads || 0) + (b.writes || 0);
                if (aSize !== bSize) return bSize - aSize;
                return a.name.length - b.name.length;
            });
            return out.slice(0, max);
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
        if (type === "getStructs") {
            if (!this.fallback.structs) {
                this.fallback.structs = await this._fetchJson("structs.json", "no-cache");
            }
            return this.fallback.structs;
        }
        if (type === "getStructShard") {
            const shard = payload.shard;
            if (!shard) return null;
            if (!this.fallback.structShards.has(shard)) {
                this.fallback.structShards.set(shard, await this._fetchJson(shard, "no-cache"));
            }
            return this.fallback.structShards.get(shard);
        }
        if (type === "getStructTouch") {
            const structs = await this._fallback("getStructs", {});
            const rec = structs && structs.types ? structs.types[payload.typeKey] : null;
            if (!rec || !rec.shard) return null;
            const data = await this._fallback("getStructShard", { shard: rec.shard });
            return data && data.types ? (data.types[payload.typeKey] || null) : null;
        }
        if (type === "getFunctionUsage") {
            const nodeId = Number(payload.nodeId);
            if (!Number.isFinite(nodeId)) return [];
            const shard = `struct/fn/${(Math.abs(nodeId) % 32).toString(16).padStart(2, "0")}.json`;
            try {
                const data = await this._fallback("getStructShard", { shard });
                return data && data.functions ? (data.functions[String(nodeId)] || []) : [];
            } catch (err) {
                return [];
            }
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

    getStructs() {
        return this._request("getStructs", {}).catch(() => null);
    }

    getStructTouch(typeKey) {
        return this._request("getStructTouch", { typeKey }).catch(() => null);
    }

    getStructShard(shard) {
        return this._request("getStructShard", { shard }).catch(() => null);
    }

    getFunctionUsage(nodeId) {
        return this._request("getFunctionUsage", { nodeId }).catch(() => []);
    }
}

// --------------------------------------------------------------------------
// Trace view model
// --------------------------------------------------------------------------

const TRACE_ROLE = { CREATE: 1, WRITE: 2, READ: 4, PASS: 8 };
// vis.py stores the via index in backward-chain step[2] for ordinary steps,
// and overwrites it with a ROLE bitmask when the chain resolves a real
// creation/write origin. VIA_INDEX["pass"] is 6 in the exporter.
const BACKWARD_VIA_PASS = 6;

/**
 * True when a backward chain has a real caller/origin link. The exporter always
 * emits a synthetic owner step (line 0, upstream -1) for a parameter, so a
 * single such step is not a traceable path.
 */
function traceHasBackwardPath(trace, paramEntity) {
    const chain = trace && trace.backward && trace.backward[paramEntity];
    if (!Array.isArray(chain) || !chain.length) return false;
    if (chain.length > 1) return true;
    const step = chain[0] || [];
    return !!step[1] || (step[4] !== null && step[4] !== undefined && step[4] >= 0);
}

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
            const rawRole = step[2];
            const role = rawRole === BACKWARD_VIA_PASS
                ? TRACE_ROLE.PASS
                : (rawRole || TRACE_ROLE.PASS);
            addRole(fn, role);
            if (!steps.has(fn)) steps.set(fn, index + 1);
            addEvent(fn, { line: step[1], role, entity: step[3], upstream });
            if (upstream !== null && upstream !== undefined && upstream >= 0) {
                edges.add(`${upstream}|${fn}`);
            }
        });
        const last = chain[chain.length - 1];
        if (last && last[0] !== undefined) originFn = last[0];
        originFile = (last && last[5]) || (trace.origin && trace.origin.file);
        // A line of 0 means the extractor could not attribute the step to a
        // concrete source line (typically a dummy-argument binding). Fall back
        // to the origin recorded with the trace so we do not show "line ?".
        originLine = (last && last[1]) || (trace.origin && trace.origin.line);
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
    const originMask = (originFn !== undefined && originFn !== null)
        ? (roles.get(originFn) || 0)
        : 0;
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
        // Whether the earliest point really is a CREATE event. Backward chains
        // used to mark their last step as CREATE unconditionally, which made a
        // dummy argument look like it was created in the caller.
        originCreated: !!(originMask & TRACE_ROLE.CREATE),
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
        traceHasBackwardPath,
        dataTraceRoleNames,
        formatIntent,
        intentMismatch,
        TRACE_ROLE
    };
}
