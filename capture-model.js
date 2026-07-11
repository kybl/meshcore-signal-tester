// CaptureModel — the single owner of captured-packet storage. It encapsulates
// the three things app.js used to touch directly (and occasionally mixed up):
//
//   • the RECENT RAM WINDOW  — a Map of the newest packets (bounded by the
//     app's RAM budget), used for live rendering and the page-0 tail;
//   • the DISK STORE         — the full capture history (IndexedDB, async);
//   • the WRITE-THROUGH path — buffers + a debounced batched flush to disk.
//
// All three are #private, so a caller physically cannot grab the raw Map or the
// store and, say, derive an all-time answer from the recent window (the "Show
// all repeaters did nothing" class of bug). Every access goes through a method
// whose name states its scope:
//
//   recent*()                       — the RAM window ONLY, never full history
//   countHashes()/eachObs()/…       — the full on-disk history (async)
//   bufferObservation()/flush()     — the write-through path
//
// The store is injectable (constructor option) so the model is unit-testable in
// Node without IndexedDB — see test/capture-model.test.js.

import { PacketStore } from './packet-store.js?v=22';

export class CaptureModel {
    #recent = new Map();     // hash → packet aggregate (the RAM window)
    #store;                  // PacketStore (full history on disk)
    #obsBuf  = [];           // pending observation records
    #sentBuf = [];           // pending outgoing-SNR records
    #hashBuf = [];           // pending per-hash payload records
    #flushTimer = null;
    #flushMs;
    #ready = false;          // disk store opened OK
    #dead  = false;          // disk store failed to open — RAM-only session
    #dataVer = 0;            // bumped whenever new records land on disk

    // Called when the disk store hits the storage quota (forwarded from it).
    onQuotaExceeded = null;
    // Supplies the totals object persisted to the 'totals' KV with each
    // scheduled flush (the resume prompt keys off the count in it).
    totalsProvider = null;

    constructor({ store = new PacketStore(), flushMs = 4000 } = {}) {
        this.#store = store;
        this.#flushMs = flushMs;
    }

    get ready()   { return this.#ready; }
    get dead()    { return this.#dead; }
    get dataVer() { return this.#dataVer; }
    get lastError() { return this.#store.lastError; }

    // Open the disk store. On failure the model goes dead: buffers are dropped
    // and all write-through becomes a no-op (nothing would ever drain them),
    // while the recent window keeps working so the session stays usable in RAM.
    async open(dbName) {
        const ok = await this.#store.open(dbName);
        if (!ok) {
            this.#dead = true;
            this.#obsBuf = []; this.#sentBuf = []; this.#hashBuf = [];
            return false;
        }
        this.#ready = true;
        this.#store.onQuotaExceeded = () => this.onQuotaExceeded?.();
        return true;
    }

    // ---- recent RAM window --------------------------------------------------
    // Explicitly windowed: these see only the newest packets, NEVER the full
    // capture. All-time questions belong to the disk methods below (or to the
    // app's maintained union model — repeaterColumns / allRepeaters).

    recentGet(hash)    { return this.#recent.get(hash); }
    recentHas(hash)    { return this.#recent.has(hash); }
    recentSet(hash, d) { this.#recent.set(hash, d); }
    recentDelete(hash) { return this.#recent.delete(hash); }
    get recentSize()   { return this.#recent.size; }
    recentValues()     { return this.#recent.values(); }
    recentEntries()    { return this.#recent.entries(); }
    recentClear()      { this.#recent.clear(); }

    // ---- write-through ------------------------------------------------------

    // Buffer one observation (and, for a new hash, its path-invariant payload)
    // and schedule the debounced batched flush.
    bufferObservation(obsRec, hashRec = null) {
        if (this.#dead) return;
        this.#obsBuf.push(obsRec);
        if (hashRec) this.#hashBuf.push(hashRec);
        this.#scheduleFlush();
    }

    bufferSent(sentRec) {
        if (this.#dead) return;
        this.#sentBuf.push(sentRec);
        this.#scheduleFlush();
    }

    #scheduleFlush() {
        if (this.#flushTimer || this.#dead) return;
        this.#flushTimer = setTimeout(() => {
            this.#flushTimer = null;
            if (!this.#ready) {
                // DB not open yet (startup): keep buffering and retry. If the
                // open failed, open() set #dead and cleared the buffers.
                if (!this.#dead && (this.#obsBuf.length || this.#sentBuf.length || this.#hashBuf.length)) this.#scheduleFlush();
                return;
            }
            const obs  = this.#obsBuf;  this.#obsBuf  = [];
            const sent = this.#sentBuf; this.#sentBuf = [];
            const hs   = this.#hashBuf; this.#hashBuf = [];
            if (hs.length)   this.#store.putHashesMerge(hs);   // before obs: readers join obs → hashes; merge keeps disk firstSeen/type/meta
            if (obs.length)  this.#store.putObs(obs);
            if (sent.length) this.#store.putSent(sent);
            if (obs.length || sent.length || hs.length) this.#dataVer++;
            const totals = this.totalsProvider?.();
            if (totals) this.#store.setKV('totals', totals);
        }, this.#flushMs);
    }

    // Flush buffered writes to disk immediately (so a following query sees the
    // newest packets). Used before export and before each live wide-view refresh.
    async flush() {
        if (!this.#ready) return;
        if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
        const dirty = this.#hashBuf.length || this.#obsBuf.length || this.#sentBuf.length;
        if (this.#hashBuf.length) { const h = this.#hashBuf; this.#hashBuf = []; await this.#store.putHashesMerge(h); }
        if (this.#obsBuf.length)  { const o = this.#obsBuf;  this.#obsBuf  = []; await this.#store.putObs(o); }
        if (this.#sentBuf.length) { const s = this.#sentBuf; this.#sentBuf = []; await this.#store.putSent(s); }
        if (dirty) this.#dataVer++;
    }

    // ---- full on-disk history (async) ---------------------------------------
    // Thin, intent-preserving delegates. They exist (rather than exposing the
    // store) so the store can stay #private and the call sites read as "the
    // model's full history", never "some other cache I could shortcut".

    countHashes(fromTime)               { return this.#store.countHashes(fromTime); }
    pageHashes(offset, limit, fromTime) { return this.#store.pageHashes(offset, limit, fromTime); }
    getHash(hash)                       { return this.#store.getHash(hash); }
    getHashes(hashes)                   { return this.#store.getHashes(hashes); }
    obsForHash(hash)                    { return this.#store.obsForHash(hash); }
    eachObs(fromTime, toTime, cb)       { return this.#store.eachObs(fromTime, toTime, cb); }
    eachSent(fromTime, toTime, cb)      { return this.#store.eachSent(fromTime, toTime, cb); }
    gridObs(fromTime, toTime, cellFn, bbox = null) { return this.#store.gridObs(fromTime, toTime, cellFn, bbox); }
    bucketObs(fromTime, toTime, buckets){ return this.#store.bucketObs(fromTime, toTime, buckets); }
    regionStats(fromTime, toTime, bbox = null) { return this.#store.regionStats(fromTime, toTime, bbox); }
    obsSpan(fromTime, toTime)           { return this.#store._obsSpan(fromTime, toTime); }
    pruneOlderThan(cutoff)              { return this.#store.pruneOlderThan(cutoff); }
    setKV(k, v)                         { return this.#store.setKV(k, v); }
    getKV(k)                            { return this.#store.getKV(k); }

    // Wipe everything this model owns: the recent window, the write buffers,
    // and the on-disk history.
    clearAll() {
        this.#recent.clear();
        this.#obsBuf = []; this.#sentBuf = []; this.#hashBuf = [];
        if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
        return this.#store.clearAll?.();
    }
}
