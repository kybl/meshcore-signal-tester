// packet-store.js
//
// IndexedDB-backed durable store for captured MeshCore observations.
//
// Why this exists: the app used to hold every captured packet in RAM for the
// whole session. With "Auto-remove: Never" (the default) a multi-hour mobile
// session grew the heap until Android OOM-killed the WebView renderer (blank
// screen). This store moves the full history to disk and lets the app keep only
// a bounded recent window in RAM for rendering. "Never" is then bounded by disk
// quota instead of RAM.
//
// Design notes:
//  - Records store only IMMUTABLE facts (hash, rawId, time, signal, position).
//    The repeater "column" a packet belongs to is a DERIVED projection of its
//    rawId computed at read time by the app's column model, so the store never
//    has to be rewritten when that model changes (promotions / merges / splits).
//  - Wide display windows ("All", or a window larger than the RAM budget) are
//    served by bucketObs(), which aggregates on disk into a bounded number of
//    (rawId, time-bucket) summaries — so rendering never materialises the whole
//    history at once.
//
// All methods are async and resolve to plain data; callers must await open()
// before use. IndexedDB is a hard requirement (available everywhere, private
// modes included) — a failed open() is surfaced by the host as an error, not
// silently worked around. The `if (!this.db)` guards in each method are only
// cheap crash protection for the async-open window and for the rare case of
// the browser closing the connection mid-session (onclose/onversionchange).

const PS_DB_NAME = 'meshcore-capture';
const PS_DB_VERSION = 3;

// --- Morton (Z-order) spatial key ----------------------------------------
// Each positioned observation gets a 32-bit Morton code interleaving a 16-bit
// quantised longitude and latitude. Points that are near in space are near in
// code, so a geographic bounding box maps to the 1D code range
// [morton(SW corner), morton(NE corner)] — a single index range scan, instead
// of scanning the whole store. The range over-covers the box (Z-order curve),
// so callers still filter the exact lat/lon afterwards, but the scan is bounded
// to the box's neighbourhood rather than all of history.
const PS_QBITS = 16, PS_QMAX = (1 << PS_QBITS) - 1;

// Exported (alongside ps_qx/ps_qy/ps_morton/ps_bigmin) for unit testing the
// spatial index in isolation — see test/spatial.test.js.
export function ps_part1by1(n) {
    n &= 0xffff;
    n = (n | (n << 8)) & 0x00ff00ff;
    n = (n | (n << 4)) & 0x0f0f0f0f;
    n = (n | (n << 2)) & 0x33333333;
    n = (n | (n << 1)) & 0x55555555;
    return n >>> 0;
}

export const PS_QUANT_MAX = PS_QMAX;
export function ps_qx(lon) { return Math.max(0, Math.min(PS_QMAX, Math.round((lon + 180) / 360 * PS_QMAX))); }
export function ps_qy(lat) { return Math.max(0, Math.min(PS_QMAX, Math.round((lat + 90)  / 180 * PS_QMAX))); }

export function ps_morton(lat, lon) {
    return (ps_part1by1(ps_qx(lon)) | (ps_part1by1(ps_qy(lat)) << 1)) >>> 0;
}

// --- Z-order (Morton) range skipping --------------------------------------
// A bbox maps to the code range [morton(SW), morton(NE)], but that linear range
// also covers out-of-box points (the Z-order "staircase"). Scanning it whole is
// O(dataset). BIGMIN gives the next code >= zcur that is back inside the box, so
// the cursor can jump over the dead stretches → O(points in box). x lives on the
// even bits, y on the odd bits (see ps_morton).

// In `value`, set this dimension's bit at position p and clear its lower bits
// (set=true → 100…0, the sub-tree min), or clear p and set the lower bits
// (set=false → 011…1, the sub-tree max). Other bits are untouched.
function ps_loadDim(value, p, set) {
    let lower = 0;
    for (let q = p - 2; q >= 0; q -= 2) lower = (lower | ((1 << q) >>> 0)) >>> 0;
    const bitP = (1 << p) >>> 0;
    const cleared = (value & (~((bitP | lower) >>> 0))) >>> 0;
    return (set ? (cleared | bitP) : (cleared | lower)) >>> 0;
}

// Smallest Morton code >= zcur that lies within the box [zmin, zmax]
// (zmin = morton(SW corner), zmax = morton(NE corner)); -1 if there is none.
// Tropf & Herzog's BIGMIN, walking bits MSB→LSB.
export function ps_bigmin(zcur, zmin, zmax) {
    let bm = -1, dmin = zmin >>> 0, dmax = zmax >>> 0;
    for (let p = 31; p >= 0; p--) {
        const bit = (1 << p) >>> 0;
        const c = ((zcur & bit) ? 4 : 0) | ((dmin & bit) ? 2 : 0) | ((dmax & bit) ? 1 : 0);
        if      (c === 1) { bm = ps_loadDim(dmin, p, true);  dmax = ps_loadDim(dmax, p, false); }
        else if (c === 3) { return dmin >>> 0; }
        else if (c === 4) { return bm; }
        else if (c === 5) { dmin = ps_loadDim(dmin, p, true); }
        // 0,7 → descend; 2,6 can't occur while dmin ≤ dmax per dimension
    }
    return bm;
}

export class PacketStore {
    constructor() {
        this.db = null;
        this._ready = null;
        this.lastError = null;
        this.dbName = PS_DB_NAME;
    }

    /** Open (and if needed create) the database. Idempotent. Never rejects —
     *  resolves to true on success, false on failure (which the host treats
     *  as a fatal storage error and reports to the user).
     *  `dbName` lets the host isolate data per browser tab (see app.js). */
    open(dbName = PS_DB_NAME) {
        if (this._ready) return this._ready;
        this.dbName = dbName;
        this._ready = new Promise((resolve) => {
            let req;
            try {
                if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
                req = indexedDB.open(dbName, PS_DB_VERSION);
            } catch (e) {
                this.lastError = e;
                console.warn('PacketStore: IndexedDB unavailable:', e);
                resolve(false);
                return;
            }
            req.onupgradeneeded = (ev) => {
                const db = req.result;
                const tx = req.transaction;            // versionchange transaction
                // obs: per-observation facts. Indexed by time (range scans),
                // by hash (gather all observations of one packet), and by mz
                // (Morton spatial key, for bounding-box map queries).
                let obs;
                if (!db.objectStoreNames.contains('obs')) {
                    obs = db.createObjectStore('obs', { keyPath: 'seq', autoIncrement: true });
                    obs.createIndex('time', 'time', { unique: false });
                } else {
                    obs = tx.objectStore('obs');
                }
                if (!obs.indexNames.contains('hash')) obs.createIndex('hash', 'hash', { unique: false });
                if (!obs.indexNames.contains('mz'))   obs.createIndex('mz', 'mz', { unique: false });
                // Backfill the Morton key on records that predate the mz index,
                // so spatial queries don't miss existing history.
                if (ev.oldVersion >= 1 && ev.oldVersion < 3) {
                    const cur = obs.openCursor();
                    cur.onsuccess = () => {
                        const c = cur.result;
                        if (!c) return;
                        const r = c.value;
                        if (r.mz == null && r.lat != null && r.lon != null) { r.mz = ps_morton(r.lat, r.lon); c.update(r); }
                        c.continue();
                    };
                }
                // hashes: per-hash payload. Indexed by firstSeen for newest-first
                // paginated table reads.
                let hashes;
                if (!db.objectStoreNames.contains('hashes')) {
                    hashes = db.createObjectStore('hashes', { keyPath: 'hash' });
                } else {
                    hashes = tx.objectStore('hashes');
                }
                if (!hashes.indexNames.contains('firstSeen')) hashes.createIndex('firstSeen', 'firstSeen', { unique: false });
                if (!db.objectStoreNames.contains('sent')) {
                    const s = db.createObjectStore('sent', { keyPath: 'seq', autoIncrement: true });
                    s.createIndex('time', 'time', { unique: false });
                }
                if (!db.objectStoreNames.contains('kv')) {
                    db.createObjectStore('kv', { keyPath: 'k' });
                }
            };
            req.onsuccess = () => {
                this.db = req.result;
                // If the connection is later closed/blocked, drop our handle so
                // the per-method guards no-op instead of throwing.
                this.db.onclose = () => { this.db = null; };
                this.db.onversionchange = () => { try { this.db.close(); } catch (_) {} this.db = null; };
                resolve(true);
            };
            req.onerror = () => {
                this.lastError = req.error;
                console.warn('PacketStore: open failed:', req.error);
                resolve(false);
            };
        });
        return this._ready;
    }

    _txComplete(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // Wrap a single IDBRequest as a Promise of its result.
    _req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Run a one-request readonly read against `storeName`. `fn(store)` returns
    // the IDBRequest to await; its result is passed through `map`. Any failure
    // (no db, transaction/request error) resolves to `fallback`, so reads never
    // throw — every caller previously hand-rolled this same try/Promise/catch.
    async _read(storeName, fn, fallback, map = (x) => x) {
        if (!this.db) return fallback;
        try {
            const tx = this.db.transaction(storeName, 'readonly');
            return map(await this._req(fn(tx.objectStore(storeName))));
        } catch (_) {
            return fallback;
        }
    }

    // Run a readwrite transaction against `storeName`. `fn(store)` queues the
    // writes; the transaction is awaited to completion. Any failure (no db,
    // transaction/request error) routes through _onWriteError and resolves to
    // false, so writes never throw — every writer previously hand-rolled this
    // same guard/try/_txComplete/catch. Returns true on commit.
    async _write(storeName, fn) {
        if (!this.db) return false;
        try {
            const tx = this.db.transaction(storeName, 'readwrite');
            fn(tx.objectStore(storeName));
            await this._txComplete(tx);
            return true;
        } catch (e) {
            this._onWriteError(e);
            return false;
        }
    }

    // ---- writes -----------------------------------------------------------

    /** Append observation records. Each:
     *    {time, hash, rawId, rawHex, snr, rssi, lat, lon, remoteSnr?}
     *  rawHex is per-observation: the SAME packet (same hash) received via a
     *  different repeater/path carries different raw bytes (the routing path
     *  field changes), so it must live here, not in the per-hash record.
     *  `seq` is assigned by the store. Returns the records or [] on failure. */
    async putObs(records) {
        if (!records || !records.length) return [];
        const ok = await this._write('obs', os => {
            for (const r of records) {
                if (r.mz == null && r.lat != null && r.lon != null) r.mz = ps_morton(r.lat, r.lon);
                os.add(r);
            }
        });
        return ok ? records : [];
    }

    /** Store the path-invariant per-hash payload once: {hash, firstSeen, type, meta}.
     *  These are identical across every path the packet arrives by (same decoded
     *  payload), so they live once per hash. The path-specific raw bytes (rawHex)
     *  live per-observation in the `obs` store instead. The decoded `packet` can
     *  be reconstructed from an observation's rawHex on demand, so it isn't stored.
     *  Uses put() so re-ingest of the same hash is harmless (last write wins). */
    async putHash(rec) {
        if (!rec) return;
        await this._write('hashes', os => os.put(rec));
    }

    /** Batched putHash: all records in one transaction. Used by the debounced
     *  write flush so a burst of new hashes doesn't cost one transaction each. */
    async putHashes(records) {
        if (!records || !records.length) return;
        await this._write('hashes', os => { for (const r of records) os.put(r); });
    }

    /** Like putHashes but never regresses a hash already on disk: keeps the
     *  earliest firstSeen and preserves an already-stored type/meta instead of
     *  overwriting it. Used by the live write-flush, where "new hash" is judged
     *  against the RAM window and so can be true for a hash still on disk (aged
     *  out of RAM) — a plain put() there would reset its firstSeen (jumping the
     *  packet to the top of the time-sorted table) and null out its type/meta. */
    async putHashesMerge(records) {
        if (!records || !records.length) return;
        await this._write('hashes', os => {
            for (const r of records) {
                const g = os.get(r.hash);
                g.onsuccess = () => {
                    const ex = g.result;
                    if (!ex) { os.put(r); return; }
                    os.put({
                        hash: r.hash,
                        firstSeen: Math.min(ex.firstSeen ?? Infinity, r.firstSeen ?? Infinity),
                        type: ex.type ?? r.type ?? null,
                        meta: ex.meta ?? r.meta ?? null,
                    });
                };
            }
        });
    }

    async getHash(hash) {
        return this._read('hashes', os => os.get(hash), null, r => r ?? null);
    }

    /** Append outgoing-SNR records: {time, snr, rawId, label}. */
    async putSent(records) {
        if (!records || !records.length) return;
        await this._write('sent', os => { for (const r of records) os.add(r); });
    }

    // ---- small key/value state (column model, aggregates, totals) ---------

    async setKV(k, v) {
        await this._write('kv', os => os.put({ k, v }));
    }

    async getKV(k) {
        return this._read('kv', os => os.get(k), undefined, r => r ? r.v : undefined);
    }

    // ---- reads ------------------------------------------------------------

    _timeRange(fromTime, toTime) {
        const lo = Number.isFinite(fromTime) ? fromTime : -Infinity;
        const hi = Number.isFinite(toTime) ? toTime : Infinity;
        if (lo === -Infinity && hi === Infinity) return null; // whole store
        if (lo === -Infinity) return IDBKeyRange.upperBound(hi);
        if (hi === Infinity) return IDBKeyRange.lowerBound(lo);
        return IDBKeyRange.bound(lo, hi);
    }

    /** Iterate obs in [fromTime, toTime] (ascending time), invoking cb(record).
     *  cb may return false to stop early. */
    async eachObs(fromTime, toTime, cb) {
        if (!this.db) return;
        await this._eachInStore('obs', fromTime, toTime, cb);
    }

    async eachSent(fromTime, toTime, cb) {
        if (!this.db) return;
        await this._eachInStore('sent', fromTime, toTime, cb);
    }

    _eachInStore(store, fromTime, toTime, cb) {
        return this._chunkedScan(store, 'time', this._timeRange(fromTime, toTime), cb);
    }

    // Index range scan in getAll() batches instead of a cursor. A cursor costs
    // one IPC round-trip per record, which stalls the main thread on large
    // scans; getAll cuts that to one round-trip per CHUNK records while keeping
    // memory bounded by the chunk size.
    //
    // Index keys are non-unique (timestamps and Morton codes collide), so a
    // chunk boundary can fall inside a run of equal keys. Paging resumes at the
    // boundary key inclusively and already-delivered records are skipped by
    // primary key; if an entire chunk is one key (e.g. a stationary capture
    // putting everything in one Morton cell), key-ranged paging cannot advance
    // and the remainder of that key run is finished with a cursor jump
    // (continuePrimaryKey) before chunking resumes past it.
    _chunkedScan(store, indexName, range, cb) {
        const CHUNK = 4096;
        return new Promise((resolve, reject) => {
            let tx;
            try { tx = this.db.transaction(store, 'readonly'); }
            catch (e) { reject(e); return; }
            const os  = tx.objectStore(store);
            const idx = os.index(indexName);
            const pk  = os.keyPath;
            let lower = range ? range.lower : undefined;
            let lowerOpen = range ? range.lowerOpen : false;
            const upper = range ? range.upper : undefined;
            const upperOpen = range ? range.upperOpen : false;
            let tailKey;          // index key at the previous chunk's end
            let tailPks = null;   // primary keys already delivered for tailKey
            const mkRange = () => {
                const hasL = lower !== undefined, hasU = upper !== undefined;
                if (hasL && hasU) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
                if (hasL) return IDBKeyRange.lowerBound(lower, lowerOpen);
                if (hasU) return IDBKeyRange.upperBound(upper, upperOpen);
                return null;
            };
            const deliver = (rec) => {
                if (tailPks && rec[indexName] === tailKey && tailPks.has(rec[pk])) return true;
                try { return cb(rec) !== false; } catch (e) { reject(e); return null; }
            };
            const finishHotKey = (key, lastPk) => {
                const req = idx.openCursor(mkRange());
                let jumped = false;
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { resolve(); return; }
                    if (!jumped) { jumped = true; cur.continuePrimaryKey(key, lastPk); return; }
                    if (cur.value[indexName] !== key) {   // run finished — resume chunking past it
                        lower = key; lowerOpen = true; tailKey = undefined; tailPks = null;
                        step();
                        return;
                    }
                    const go = deliver(cur.value);
                    tailPks.add(cur.value[pk]);
                    if (go === null) return;
                    if (!go) { resolve(); return; }
                    cur.continue();
                };
                req.onerror = () => reject(req.error);
            };
            const step = () => {
                const req = idx.getAll(mkRange(), CHUNK);
                req.onsuccess = () => {
                    const recs = req.result;
                    for (const rec of recs) {
                        const go = deliver(rec);
                        if (go === null) return;
                        if (!go) { resolve(); return; }
                    }
                    if (recs.length < CHUNK) { resolve(); return; }
                    const newTail = recs[recs.length - 1][indexName];
                    const stuck = recs[0][indexName] === newTail;   // whole chunk = one key run
                    const pks = (tailKey === newTail && tailPks) ? tailPks : new Set();
                    for (let i = recs.length - 1; i >= 0 && recs[i][indexName] === newTail; i--) pks.add(recs[i][pk]);
                    tailKey = newTail; tailPks = pks;
                    if (stuck) { finishHotKey(newTail, recs[recs.length - 1][pk]); return; }
                    lower = newTail; lowerOpen = false;
                    step();
                };
                req.onerror = () => reject(req.error);
            };
            step();
        });
    }

    /** Iterate positioned obs, optionally restricted to a geographic bbox. With
     *  a bbox the Morton index is used (single range scan over the box's
     *  neighbourhood, then exact filter); without one it falls back to the time
     *  index. Only records with lat/lon are yielded. cb may return false to stop. */
    _eachPositioned(fromTime, toTime, bbox, cb) {
        if (!this.db) return Promise.resolve();
        if (bbox) return this._eachByBbox(bbox, fromTime, toTime, cb);
        return this._eachInStore('obs', fromTime, toTime, r => {
            if (r.lat == null || r.lon == null) return true;
            return cb(r) !== false;
        });
    }

    _eachByBbox(bbox, fromTime, toTime, cb) {
        const zmin = ps_morton(bbox.minLat, bbox.minLon);
        const zmax = ps_morton(bbox.maxLat, bbox.maxLon);
        const qx0 = ps_qx(bbox.minLon), qx1 = ps_qx(bbox.maxLon);
        const qy0 = ps_qy(bbox.minLat), qy1 = ps_qy(bbox.maxLat);
        const tLo = Number.isFinite(fromTime) ? fromTime : -Infinity;
        const tHi = Number.isFinite(toTime) ? toTime : Infinity;
        return new Promise((resolve, reject) => {
            let tx;
            try { tx = this.db.transaction('obs', 'readonly'); }
            catch (e) { reject(e); return; }
            const req = tx.objectStore('obs').index('mz').openCursor(IDBKeyRange.bound(zmin, zmax));
            req.onsuccess = () => {
                const cur = req.result;
                if (!cur) { resolve(); return; }
                const r = cur.value;
                if (r.lat == null || r.lon == null) { cur.continue(); return; }
                const qx = ps_qx(r.lon), qy = ps_qy(r.lat);
                if (qx >= qx0 && qx <= qx1 && qy >= qy0 && qy <= qy1) {
                    // Inside the box (Morton-wise): apply the exact lat/lon + time filter.
                    if (r.lat >= bbox.minLat && r.lat <= bbox.maxLat &&
                        r.lon >= bbox.minLon && r.lon <= bbox.maxLon &&
                        r.time >= tLo && r.time <= tHi) {
                        let go; try { go = cb(r); } catch (e) { reject(e); return; }
                        if (go === false) { resolve(); return; }
                    }
                    cur.continue();
                } else {
                    // Out of box (Z-order spillover): jump to the next in-box code.
                    const key = cur.key >>> 0;
                    const nz = ps_bigmin(key, zmin, zmax);
                    if (nz < 0 || nz <= key) { cur.continue(); return; }
                    cur.continue(nz);
                }
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Downsampled query for wide windows. Buckets obs in [fromTime, toTime] into
     * at most `buckets` equal time slots, grouped by rawId. Returns
     *   { buckets: [{ rawId, bIdx, time, count,
     *                 snrMin, snrMax, snrAvg, snrSum, snrN,
     *                 rssiMin, rssiMax, rssiAvg, rssiSum, rssiN,
     *                 lastSnr, lastSnrT, lastRssi, lastRssiT,  // newest reading in bucket
     *                 lat, lon }],   // lat/lon = last seen position in the bucket
     *     width, lo }
     *
     * Memory is bounded by (distinct rawIds × buckets), independent of how many
     * raw packets the span contains. The caller derives the display column from
     * rawId via its column model. `time` is the bucket midpoint; bIdx/width/lo
     * (plus the sums) let the caller fold further observations into the same
     * bucket space incrementally.
     */
    async bucketObs(fromTime, toTime, buckets) {
        if (!this.db) return { buckets: [], width: 1, lo: 0 };
        // Resolve the real span first so bucket width is sane even for "All".
        const span = await this._obsSpan(fromTime, toTime);
        if (!span) return { buckets: [], width: 1, lo: 0 };
        const lo = Number.isFinite(fromTime) ? fromTime : span.min;
        const hi = Number.isFinite(toTime) ? toTime : span.max;
        const width = Math.max(1, Math.ceil((hi - lo + 1) / Math.max(1, buckets)));
        const groups = new Map(); // key `${rawId}|${bucketIdx}` -> accumulator
        await this.eachObs(lo, hi, (r) => {
            const bIdx = Math.floor((r.time - lo) / width);
            const key = r.rawId + '|' + bIdx;
            let g = groups.get(key);
            if (!g) {
                g = { rawId: r.rawId, bIdx, count: 0,
                      snrMin: Infinity, snrMax: -Infinity, snrSum: 0, snrN: 0,
                      rssiMin: Infinity, rssiMax: -Infinity, rssiSum: 0, rssiN: 0,
                      lastSnrT: -Infinity, lastSnr: null, lastRssiT: -Infinity, lastRssi: null,
                      lat: null, lon: null, lastTime: 0,
                      // First obs's exact time + hash, surfaced only for count===1
                      // buckets so the chart tooltip can show ms + look up the type.
                      firstTime: r.time, hash: r.hash };
                groups.set(key, g);
            }
            g.count++;
            if (r.snr != null) { g.snrN++; g.snrSum += r.snr; if (r.snr < g.snrMin) g.snrMin = r.snr; if (r.snr > g.snrMax) g.snrMax = r.snr; if (r.time >= g.lastSnrT) { g.lastSnrT = r.time; g.lastSnr = r.snr; } }
            if (r.rssi != null) { g.rssiN++; g.rssiSum += r.rssi; if (r.rssi < g.rssiMin) g.rssiMin = r.rssi; if (r.rssi > g.rssiMax) g.rssiMax = r.rssi; if (r.time >= g.lastRssiT) { g.lastRssiT = r.time; g.lastRssi = r.rssi; } }
            if (r.lat != null && r.time >= g.lastTime) { g.lat = r.lat; g.lon = r.lon; g.lastTime = r.time; }
        });
        const out = [];
        for (const g of groups.values()) {
            out.push({
                rawId: g.rawId,
                bIdx: g.bIdx,
                time: lo + g.bIdx * width + Math.floor(width / 2),
                count: g.count,
                snrMin: g.snrN ? g.snrMin : null,
                snrMax: g.snrN ? g.snrMax : null,
                snrAvg: g.snrN ? g.snrSum / g.snrN : null,
                // Sums are included so callers can MERGE further observations into
                // a bucket incrementally (avg alone can't be combined).
                snrSum: g.snrSum, snrN: g.snrN,
                rssiMin: g.rssiN ? g.rssiMin : null,
                rssiMax: g.rssiN ? g.rssiMax : null,
                rssiAvg: g.rssiN ? g.rssiSum / g.rssiN : null,
                rssiSum: g.rssiSum, rssiN: g.rssiN,
                // Newest non-null SNR/RSSI in the bucket (by time) — the true
                // "last" value, tracked the same way live ingestion does, so
                // disk-restored Seen Repeaters rows show a real reading, not the
                // bucket average. The times let callers fold further obs in.
                lastSnr: g.lastSnr, lastSnrT: g.lastSnrT,
                lastRssi: g.lastRssi, lastRssiT: g.lastRssiT,
                lat: g.lat, lon: g.lon,
                // Single-reception bucket = one packet: expose its exact time and
                // hash so the tooltip shows ms and can resolve the packet type.
                ...(g.count === 1 ? { exactTime: g.firstTime, hash: g.hash } : {}),
            });
        }
        out.sort((a, b) => a.time - b.time);
        // width/lo let the caller key further (live) observations into the same
        // bucket space: bIdx = floor((t - lo) / width).
        return { buckets: out, width, lo };
    }

    /** min/max time present in obs within an optional range, or null if empty. */
    async _obsSpan(fromTime, toTime) {
        if (!this.db) return null;
        try {
            return await new Promise((resolve, reject) => {
                const tx = this.db.transaction('obs', 'readonly');
                const idx = tx.objectStore('obs').index('time');
                const range = this._timeRange(fromTime, toTime);
                let min = null, max = null;
                const lo = idx.openCursor(range, 'next');
                lo.onsuccess = () => {
                    const c = lo.result;
                    if (c) min = c.value.time;
                    const hiReq = idx.openCursor(range, 'prev');
                    hiReq.onsuccess = () => {
                        const c2 = hiReq.result;
                        if (c2) max = c2.value.time;
                        resolve(min == null ? null : { min, max });
                    };
                    hiReq.onerror = () => reject(hiReq.error);
                };
                lo.onerror = () => reject(lo.error);
            });
        } catch (_) { return null; }
    }

    // ---- spatial downsampling (3D map) ------------------------------------

    /** count + lat/lon bounding box over obs in [from,to], optionally clipped to
     *  a geographic bbox {minLat,maxLat,minLon,maxLon}. Only positioned obs are
     *  counted. Used to pre-estimate the map cluster grid cell size. */
    async regionStats(fromTime, toTime, bbox = null) {
        const out = { count: 0, minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
        if (!this.db) return out;
        await this._eachPositioned(fromTime, toTime, bbox, r => {
            out.count++;
            if (r.lat < out.minLat) out.minLat = r.lat;
            if (r.lat > out.maxLat) out.maxLat = r.lat;
            if (r.lon < out.minLon) out.minLon = r.lon;
            if (r.lon > out.maxLon) out.maxLon = r.lon;
        });
        return out;
    }

    /** Spatially downsample obs in [from,to] onto a lat/lon grid of `cellMeters`
     *  cells, grouped by rawId. Keeps one representative per (rawId, cell): the
     *  strongest-RSSI observation, plus a count. Optionally clipped to bbox.
     *  Output is bounded by (#cells × #rawIds), independent of input size. */
    // Aggregate positioned obs into per-repeater grid cells. `cellFn(lat, lon)`
    // returns the cell indices {gx, gy}; the caller (app.js) supplies the map
    // LOD binning (maplod.cellIndices) so cell definition lives in one place.
    async gridObs(fromTime, toTime, cellFn, bbox = null) {
        if (!this.db || typeof cellFn !== 'function') return [];
        const groups = new Map(); // `${rawId}|${gx}|${gy}` -> representative
        await this._eachPositioned(fromTime, toTime, bbox, r => {
            const { gx, gy } = cellFn(r.lat, r.lon);
            const key = r.rawId + '|' + gx + '|' + gy;
            let g = groups.get(key);
            if (!g) { g = { rawId: r.rawId, lat: r.lat, lon: r.lon, snr: r.snr, rssi: r.rssi, time: r.time, count: 0 }; groups.set(key, g); }
            g.count++;
            // Representative = the most recent observation in the cell, so the
            // map shows current conditions (spire height = its SNR), not a
            // best-ever value.
            if (r.time >= g.time) {
                g.lat = r.lat; g.lon = r.lon; g.snr = r.snr; g.rssi = r.rssi; g.time = r.time;
            }
        });
        return [...groups.values()];
    }

    // ---- paginated table reads --------------------------------------------

    /** Count hash records, optionally only those first seen at/after `fromTime`
     *  (the table's display window). */
    async countHashes(fromTime) {
        return this._read('hashes', os => {
            const idx = os.index('firstSeen');
            return Number.isFinite(fromTime) ? idx.count(IDBKeyRange.lowerBound(fromTime)) : idx.count();
        }, 0);
    }

    /** Newest-first page of hash records (ordered by firstSeen descending),
     *  optionally restricted to firstSeen >= fromTime. */
    async pageHashes(offset, limit, fromTime) {
        if (!this.db) return [];
        try {
            return await new Promise((resolve, reject) => {
                const tx = this.db.transaction('hashes', 'readonly');
                const idx = tx.objectStore('hashes').index('firstSeen');
                const out = [];
                let skipped = false;
                const range = Number.isFinite(fromTime) ? IDBKeyRange.lowerBound(fromTime) : null;
                const req = idx.openCursor(range, 'prev');
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { resolve(out); return; }
                    if (offset > 0 && !skipped) { skipped = true; cur.advance(offset); return; }
                    out.push(cur.value);
                    if (out.length >= limit) { resolve(out); return; }
                    cur.continue();
                };
                req.onerror = () => reject(req.error);
            });
        } catch (_) { return []; }
    }

    /** Batched getHash (one readonly transaction), records in input order.
     *  Used by the repeater-filtered table pager, which pages by hash list
     *  instead of the firstSeen index. A hash with no stored record (shouldn't
     *  happen; defensive) yields a {hash}-only stub. */
    async getHashes(hashes) {
        if (!this.db || !hashes.length) return [];
        try {
            return await new Promise((resolve, reject) => {
                const tx = this.db.transaction('hashes', 'readonly');
                const os = tx.objectStore('hashes');
                const out = new Array(hashes.length);
                let pending = hashes.length;
                hashes.forEach((h, i) => {
                    const r = os.get(h);
                    r.onsuccess = () => { out[i] = r.result ?? { hash: h }; if (--pending === 0) resolve(out); };
                    r.onerror = () => reject(r.error);
                });
            });
        } catch (_) { return hashes.map(h => ({ hash: h })); }
    }

    /** All observations of one hash (every path/repeater it arrived by). */
    async obsForHash(hash) {
        return this._read('obs', os => os.index('hash').getAll(hash), [], r => r || []);
    }

    // ---- maintenance ------------------------------------------------------

    /** Delete obs and sent records older than `cutoff` (used for finite
     *  Auto-remove, which truly deletes). hashes are left (cheap; orphans are
     *  harmless and reused if the hash reappears). */
    /** Delete observations/sent records older than `cutoff`, then hash records
     *  left with no observations at all (otherwise the hashes store would grow
     *  forever under a finite retention, inflating the table's page count and
     *  yielding empty pages). Only hashes with firstSeen < cutoff can have
     *  become empty, so the orphan check is bounded by what just expired — not
     *  the whole store. Resolves to the number of hash records deleted. */
    async pruneOlderThan(cutoff) {
        if (!this.db || !Number.isFinite(cutoff)) return 0;
        for (const store of ['obs', 'sent']) {
            try {
                await new Promise((resolve, reject) => {
                    const tx = this.db.transaction(store, 'readwrite');
                    const idx = tx.objectStore(store).index('time');
                    const req = idx.openCursor(IDBKeyRange.upperBound(cutoff, true));
                    req.onsuccess = () => {
                        const cur = req.result;
                        if (!cur) return;
                        cur.delete();
                        cur.continue();
                    };
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                    tx.onabort = () => reject(tx.error);
                });
            } catch (e) { console.warn(`PacketStore: prune ${store} failed:`, e); }
        }
        let deletedHashes = 0;
        try {
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(['hashes', 'obs'], 'readwrite');
                const obsByHash = tx.objectStore('obs').index('hash');
                const req = tx.objectStore('hashes').index('firstSeen')
                    .openCursor(IDBKeyRange.upperBound(cutoff, true));
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) return;
                    // getKey resolves to the first matching obs primary key, or
                    // undefined when the hash has no observations left.
                    const probe = obsByHash.getKey(cur.value.hash);
                    probe.onsuccess = () => {
                        if (probe.result === undefined) { cur.delete(); deletedHashes++; }
                        cur.continue();
                    };
                    probe.onerror = (e) => { e.preventDefault(); cur.continue(); };
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (e) { console.warn('PacketStore: prune hashes failed:', e); }
        return deletedHashes;
    }

    async clearAll() {
        if (!this.db) return;
        try {
            const tx = this.db.transaction(['obs', 'hashes', 'sent', 'kv'], 'readwrite');
            tx.objectStore('obs').clear();
            tx.objectStore('hashes').clear();
            tx.objectStore('sent').clear();
            tx.objectStore('kv').clear();
            await this._txComplete(tx);
        } catch (e) { console.warn('PacketStore: clearAll failed:', e); }
    }

    _onWriteError(e) {
        this.lastError = e;
        // QuotaExceededError is the expected long-run failure mode. We surface it
        // but don't throw — the app keeps running on its RAM window; the host can
        // decide to prune oldest. Other errors are logged for diagnosis.
        if (e && e.name === 'QuotaExceededError') {
            if (!this._quotaWarned) {
                console.warn('PacketStore: storage quota exceeded; oldest history may not persist.');
                this._quotaWarned = true;
            }
            this.onQuotaExceeded?.();
        } else {
            console.warn('PacketStore: write failed:', e);
        }
    }
}
