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
// (or check `.available`) before use. Every method is a no-op / empty result
// when the DB failed to open, so the app degrades to in-RAM-only behaviour
// rather than crashing if IndexedDB is unavailable (e.g. private mode).

const PS_DB_NAME = 'meshcore-capture';
const PS_DB_VERSION = 1;

export class PacketStore {
    constructor() {
        this.db = null;
        this._ready = null;
        this.lastError = null;
    }

    /** Open (and if needed create) the database. Idempotent. Never rejects —
     *  resolves to true on success, false if IndexedDB is unavailable. */
    open() {
        if (this._ready) return this._ready;
        this._ready = new Promise((resolve) => {
            let req;
            try {
                if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
                req = indexedDB.open(PS_DB_NAME, PS_DB_VERSION);
            } catch (e) {
                this.lastError = e;
                console.warn('PacketStore: IndexedDB unavailable, falling back to RAM-only:', e);
                resolve(false);
                return;
            }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('obs')) {
                    const obs = db.createObjectStore('obs', { keyPath: 'seq', autoIncrement: true });
                    obs.createIndex('time', 'time', { unique: false });
                }
                if (!db.objectStoreNames.contains('hashes')) {
                    db.createObjectStore('hashes', { keyPath: 'hash' });
                }
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
                // callers fall back to RAM-only instead of throwing.
                this.db.onclose = () => { this.db = null; };
                this.db.onversionchange = () => { try { this.db.close(); } catch (_) {} this.db = null; };
                resolve(true);
            };
            req.onerror = () => {
                this.lastError = req.error;
                console.warn('PacketStore: open failed, falling back to RAM-only:', req.error);
                resolve(false);
            };
        });
        return this._ready;
    }

    get available() { return !!this.db; }

    _txComplete(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    // ---- writes -----------------------------------------------------------

    /** Append observation records. Each:
     *    {time, hash, rawId, rawHex, snr, rssi, lat, lon, remoteSnr?}
     *  rawHex is per-observation: the SAME packet (same hash) received via a
     *  different repeater/path carries different raw bytes (the routing path
     *  field changes), so it must live here, not in the per-hash record.
     *  `seq` is assigned by the store. Returns the records or [] on failure. */
    async putObs(records) {
        if (!this.db || !records || !records.length) return [];
        try {
            const tx = this.db.transaction('obs', 'readwrite');
            const os = tx.objectStore('obs');
            for (const r of records) os.add(r);
            await this._txComplete(tx);
            return records;
        } catch (e) {
            this._onWriteError(e);
            return [];
        }
    }

    /** Store the path-invariant per-hash payload once: {hash, firstSeen, type, meta}.
     *  These are identical across every path the packet arrives by (same decoded
     *  payload), so they live once per hash. The path-specific raw bytes (rawHex)
     *  live per-observation in the `obs` store instead. The decoded `packet` can
     *  be reconstructed from an observation's rawHex on demand, so it isn't stored.
     *  Uses put() so re-ingest of the same hash is harmless (last write wins). */
    async putHash(rec) {
        if (!this.db || !rec) return;
        try {
            const tx = this.db.transaction('hashes', 'readwrite');
            tx.objectStore('hashes').put(rec);
            await this._txComplete(tx);
        } catch (e) { this._onWriteError(e); }
    }

    async getHash(hash) {
        if (!this.db) return null;
        try {
            return await new Promise((resolve, reject) => {
                const tx = this.db.transaction('hashes', 'readonly');
                const r = tx.objectStore('hashes').get(hash);
                r.onsuccess = () => resolve(r.result ?? null);
                r.onerror = () => reject(r.error);
            });
        } catch (_) { return null; }
    }

    /** Append outgoing-SNR records: {time, snr, rawId, label}. */
    async putSent(records) {
        if (!this.db || !records || !records.length) return;
        try {
            const tx = this.db.transaction('sent', 'readwrite');
            const os = tx.objectStore('sent');
            for (const r of records) os.add(r);
            await this._txComplete(tx);
        } catch (e) { this._onWriteError(e); }
    }

    // ---- small key/value state (column model, aggregates, totals) ---------

    async setKV(k, v) {
        if (!this.db) return;
        try {
            const tx = this.db.transaction('kv', 'readwrite');
            tx.objectStore('kv').put({ k, v });
            await this._txComplete(tx);
        } catch (e) { this._onWriteError(e); }
    }

    async getKV(k) {
        if (!this.db) return undefined;
        try {
            return await new Promise((resolve, reject) => {
                const tx = this.db.transaction('kv', 'readonly');
                const r = tx.objectStore('kv').get(k);
                r.onsuccess = () => resolve(r.result ? r.result.v : undefined);
                r.onerror = () => reject(r.error);
            });
        } catch (_) { return undefined; }
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
        return new Promise((resolve, reject) => {
            let tx;
            try { tx = this.db.transaction(store, 'readonly'); }
            catch (e) { reject(e); return; }
            const idx = tx.objectStore(store).index('time');
            const req = idx.openCursor(this._timeRange(fromTime, toTime));
            req.onsuccess = () => {
                const cur = req.result;
                if (!cur) { resolve(); return; }
                let keepGoing = true;
                try { keepGoing = cb(cur.value) !== false; } catch (e) { reject(e); return; }
                if (keepGoing) cur.continue(); else resolve();
            };
            req.onerror = () => reject(req.error);
        });
    }

    async countObs(fromTime, toTime) {
        if (!this.db) return 0;
        try {
            return await new Promise((resolve, reject) => {
                const tx = this.db.transaction('obs', 'readonly');
                const idx = tx.objectStore('obs').index('time');
                const range = this._timeRange(fromTime, toTime);
                const r = range ? idx.count(range) : idx.count();
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });
        } catch (_) { return 0; }
    }

    /**
     * Downsampled query for wide windows. Buckets obs in [fromTime, toTime] into
     * at most `buckets` equal time slots, grouped by rawId, and returns an array
     * of summaries:
     *   { rawId, time, count,
     *     snrMin, snrMax, snrAvg, rssiMin, rssiMax, rssiAvg,
     *     lat, lon }          // lat/lon = last seen position in the bucket
     *
     * Memory is bounded by (distinct rawIds × buckets), independent of how many
     * raw packets the span contains. The caller derives the display column from
     * rawId via its column model. `time` is the bucket midpoint.
     */
    async bucketObs(fromTime, toTime, buckets) {
        if (!this.db) return [];
        // Resolve the real span first so bucket width is sane even for "All".
        const span = await this._obsSpan(fromTime, toTime);
        if (!span) return [];
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
                      lat: null, lon: null, lastTime: 0 };
                groups.set(key, g);
            }
            g.count++;
            if (r.snr != null) { g.snrN++; g.snrSum += r.snr; if (r.snr < g.snrMin) g.snrMin = r.snr; if (r.snr > g.snrMax) g.snrMax = r.snr; }
            if (r.rssi != null) { g.rssiN++; g.rssiSum += r.rssi; if (r.rssi < g.rssiMin) g.rssiMin = r.rssi; if (r.rssi > g.rssiMax) g.rssiMax = r.rssi; }
            if (r.lat != null && r.time >= g.lastTime) { g.lat = r.lat; g.lon = r.lon; g.lastTime = r.time; }
        });
        const out = [];
        for (const g of groups.values()) {
            out.push({
                rawId: g.rawId,
                time: lo + g.bIdx * width + Math.floor(width / 2),
                count: g.count,
                snrMin: g.snrN ? g.snrMin : null,
                snrMax: g.snrN ? g.snrMax : null,
                snrAvg: g.snrN ? g.snrSum / g.snrN : null,
                rssiMin: g.rssiN ? g.rssiMin : null,
                rssiMax: g.rssiN ? g.rssiMax : null,
                rssiAvg: g.rssiN ? g.rssiSum / g.rssiN : null,
                lat: g.lat, lon: g.lon,
            });
        }
        out.sort((a, b) => a.time - b.time);
        return out;
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

    // ---- maintenance ------------------------------------------------------

    /** Delete obs and sent records older than `cutoff` (used for finite
     *  Auto-remove, which truly deletes). hashes are left (cheap; orphans are
     *  harmless and reused if the hash reappears). */
    async pruneOlderThan(cutoff) {
        if (!this.db || !Number.isFinite(cutoff)) return;
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
