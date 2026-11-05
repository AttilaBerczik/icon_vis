/*
 * dataflow-worker.js — fetches and parses the static data-flow files off the
 * main thread. The worker only ever sends small id arrays / objects back, so
 * neither JSON parsing nor the trace lookup can block rendering.
 */
"use strict";

let BASE = "vis/";
let searchIndex = null;
let searchPromise = null;
const fnShards = new Map();
const fnShardPromises = new Map();
const traceShards = new Map();
const tracePromises = new Map();
const TRACE_CACHE_LIMIT = 16;
const STRUCT_KINDS = ["field", "param", "var", "struct", "local"];
let structsIndex = null;
let structsPromise = null;
const structShards = new Map();
const structShardPromises = new Map();

function cachePut(cache, key, value, limit) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (limit && cache.size > limit) {
        cache.delete(cache.keys().next().value);
    }
}

async function fetchJson(relPath, cacheMode) {
    // Struct data is rebuilt far more often than the call graph while the
    // explorer is being developed; revalidate it instead of serving a stale
    // HTTP-cache entry. The other large files keep force-cache.
    const res = await fetch(BASE + relPath, { cache: cacheMode || "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${relPath}`);
    return res.json();
}

async function loadSearch() {
    if (searchIndex) return searchIndex;
    if (!searchPromise) {
        searchPromise = fetchJson("search.json").then((data) => {
            searchIndex = data;
            return data;
        });
    }
    return searchPromise;
}

function lowerBound(names, query) {
    let lo = 0;
    let hi = names.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (names[mid] < query) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

async function search(query, limit) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    const data = await loadSearch();
    const names = data.names;
    const start = lowerBound(names, q);
    const out = [];
    const seenGroups = new Set();
    const max = Math.max(1, Math.min(limit || 50, 100));
    for (let i = start; i < names.length; i += 1) {
        const name = names[i];
        if (!name.startsWith(q)) break;
        const gid = data.groups[i];
        if (seenGroups.has(gid)) continue;
        seenGroups.add(gid);
        out.push({
            name,
            groupId: gid,
            kind: STRUCT_KINDS[data.kinds[i]] || "other",
            reads: data.reads[i],
            writes: data.writes[i],
            type: (data.types && data.types[i]) || "",
            member: (data.members && data.members[i]) || "",
            fns: (data.fns && data.fns[i]) || 0
        });
        if (out.length >= max * 2) break;
    }
    // Types are the entry point to the explorer and are shown in the first
    // group; ranking them behind hundreds of same-named parameters would make
    // a type unreachable after the result cap.
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

async function getParams(fnId, shard) {
    if (!shard) return null;
    let data = fnShards.get(shard);
    if (!data) {
        let promise = fnShardPromises.get(shard);
        if (!promise) {
            promise = fetchJson(shard).then((payload) => {
                fnShards.set(shard, payload);
                fnShardPromises.delete(shard);
                return payload;
            });
            fnShardPromises.set(shard, promise);
        }
        data = await promise;
    }
    return (data.functions || {})[fnId] || null;
}

async function getTrace(gid) {
    if (!gid) return null;
    if (traceShards.has(gid)) {
        const hit = traceShards.get(gid);
        cachePut(traceShards, gid, hit, TRACE_CACHE_LIMIT);
        return hit;
    }
    const shard = gid.slice(0, 2);
    let payload = traceShards.get("_" + shard);
    if (!payload) {
        let promise = tracePromises.get(shard);
        if (!promise) {
            promise = fetchJson(`trace/${shard}.json`).then((data) => {
                tracePromises.delete(shard);
                return data;
            });
            tracePromises.set(shard, promise);
        }
        payload = await promise;
        cachePut(traceShards, "_" + shard, payload, TRACE_CACHE_LIMIT);
    }
    const record = (payload.groups || {})[gid] || null;
    if (record) cachePut(traceShards, gid, record, TRACE_CACHE_LIMIT);
    return record;
}

async function getStructs() {
    if (structsIndex) return structsIndex;
    if (!structsPromise) {
        structsPromise = fetchJson("structs.json", "no-cache").then((data) => {
            structsIndex = data;
            return data;
        });
    }
    return structsPromise;
}

async function getStructShard(shard) {
    if (!shard) return null;
    if (structShards.has(shard)) return structShards.get(shard);
    let promise = structShardPromises.get(shard);
    if (!promise) {
        promise = fetchJson(shard, "no-cache").then((payload) => {
            structShards.set(shard, payload);
            structShardPromises.delete(shard);
            return payload;
        });
        structShardPromises.set(shard, promise);
    }
    return promise;
}

async function getStructTouch(typeKey) {
    const structs = await getStructs();
    const rec = structs && structs.types ? structs.types[typeKey] : null;
    if (!rec || !rec.shard) return null;
    const payload = await getStructShard(rec.shard);
    return payload && payload.types ? (payload.types[typeKey] || null) : null;
}

async function getFunctionUsage(nodeId) {
    if (nodeId === null || nodeId === undefined) return null;
    const shard = `struct/fn/${(Math.abs(Number(nodeId)) % 32).toString(16).padStart(2, "0")}.json`;
    const payload = await getStructShard(shard);
    return payload && payload.functions ? (payload.functions[String(nodeId)] || []) : [];
}

async function prefetchParams(shards) {
    if (!Array.isArray(shards)) return;
    for (const shard of shards) {
        if (!shard || fnShards.has(shard)) continue;
        try {
            const payload = await fetchJson(shard);
            fnShards.set(shard, payload);
        } catch (err) {
            // Optional prefetch: a failure must never break the page.
        }
    }
}

self.addEventListener("message", (event) => {
    const msg = event.data || {};
    const { id, type, payload } = msg;
    if (type === "init") {
        BASE = payload && payload.base ? payload.base : BASE;
        self.postMessage({ id, ok: true, result: true });
        return;
    }
    let task;
    if (type === "search") task = search(payload.query, payload.limit);
    else if (type === "getParams") task = getParams(payload.fnId, payload.shard);
    else if (type === "getTrace") task = getTrace(payload.groupId);
    else if (type === "getStructs") task = getStructs();
    else if (type === "getStructShard") task = getStructShard(payload.shard);
    else if (type === "getStructTouch") task = getStructTouch(payload.typeKey);
    else if (type === "getFunctionUsage") task = getFunctionUsage(payload.nodeId);
    else if (type === "prefetchParams") task = prefetchParams(payload.shards);
    else task = Promise.reject(new Error(`unknown request ${type}`));
    task.then((result) => {
        self.postMessage({ id, ok: true, result });
    }).catch((err) => {
        self.postMessage({ id, ok: false, error: String(err && err.message || err) });
    });
});
