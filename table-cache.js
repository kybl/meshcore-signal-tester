// TableCache — the Received Packets table's disk-page cache, extracted from
// app.js so its state is #private and every read goes through an intent-named
// method. It owns:
//
//   • the current DISK PAGE SNAPSHOT (newest `pageSize` hashes, assembled into
//     recent-window-shaped entries) + page/pageCount/hashCount for the pager;
//   • the NARROW INDEX (hashes matching the active repeater selection/filter,
//     newest-first), kept live at ingest and rebuilt on narrowing changes;
//   • the RAM∪disk UNION reads the app used to spell by hand — rowData() and
//     hasRow() are "the page snapshot, else the live recent window", and
//     visibleRows() is "the snapshot plus the page-0 live tail, windowed,
//     sorted, capped" — so callers can't accidentally read only one side.
//
// App-level concerns stay injected (deps): column resolution, the narrowing
// predicate/key (selection & filter), and the Display-window cutoff. The model
// (CaptureModel) supplies both storage sides. Unit-testable with stubs — see
// test/table-cache.test.js.

export class TableCache {
    #model;
    #deps;                       // { resolveCol, narrowFn, narrowKey, displayCutoff }
    #pageSize;
    #pageData = new Map();       // hash → row entry (the disk page snapshot)
    #page = 0;
    #pageCount = 1;
    #hashCount = 0;              // distinct hashes on disk (RAM-maintained between loads)
    #cacheAt = 0;                // time the snapshot reflects; newer rows are the live tail
    #narrowHashes = null;        // newest-first matching hashes (null = not narrowed / stale)
    #narrowSet = null;           // same content as a Set, for O(1) ingest checks
    #narrowIndexKey = '';        // narrow key the index hashes were built for
    #narrowKeyApplied = '';      // narrow key the current page was loaded for
    #firstPageColCounts = new Map(); // per-column occurrences on page 0 (column sort key #2)

    constructor(model, { pageSize = 100, resolveCol, narrowFn, narrowKey, displayCutoff }) {
        this.#model = model;
        this.#pageSize = pageSize;
        this.#deps = { resolveCol, narrowFn, narrowKey, displayCutoff };
    }

    get page()      { return this.#page; }
    get pageCount() { return this.#pageCount; }
    get hashCount() { return this.#hashCount; }
    get pageSize()  { return this.#pageSize; }
    get cacheAt()   { return this.#cacheAt; }
    get narrowed()  { return this.#narrowHashes != null; }
    get firstPageColCounts() { return this.#firstPageColCounts; }

    // ---- union reads (page snapshot ∪ live recent window) -------------------

    rowData(hash) { return this.#pageData.get(hash) ?? this.#model.recentGet(hash); }
    hasRow(hash)  { return this.#pageData.has(hash) || this.#model.recentHas(hash); }

    // Rows to render: the disk page snapshot plus, on page 0, a live tail of
    // packets newer than the snapshot so new rows show instantly. Pre-ready
    // (store still opening) the snapshot is empty and the cutoff-filtered tail
    // alone is the full live RAM window — one path. The Display-window cutoff
    // applies to the snapshot too (it is loaded once and ages on screen), and
    // page 0 is capped at the page size (the live tail can outgrow it; older
    // rows are reachable via the pager — except pre-ready, when there is none).
    visibleRows() {
        const cutoff = this.#deps.displayCutoff();
        const narrowFn = this.#deps.narrowFn();
        const m = new Map(this.#pageData);
        if (this.#page === 0) {
            for (const [h, d] of this.#model.recentEntries()) {
                if (d.lastSeen <= this.#cacheAt) continue;
                // When narrowed the snapshot holds only matching hashes — keep the
                // tail consistent so hidden rows don't eat the page cap.
                if (narrowFn && ![...d.repeaters.keys()].some(narrowFn)) continue;
                m.set(h, d);
            }
        }
        let rows = [...m.entries()]
            .filter(([, data]) => !data._stub && (!cutoff || data.firstSeen >= cutoff))
            .sort(([, a], [, b]) => b.firstSeen - a.firstSeen);
        if (this.#page === 0 && this.#model.ready && rows.length > this.#pageSize) {
            rows = rows.slice(0, this.#pageSize);
        }
        return rows;
    }

    // ---- keeping the pager current without disk reads ------------------------

    // Fold one live packet in: bump the RAM-maintained hash count, extend the
    // narrow index (an OLD hash can newly join it when the narrowed repeater
    // hears it for the first time — guard on the index being current for the
    // active narrowing), and recompute the page count.
    noteIngest(hash, canonicalKey, isNewHash) {
        if (isNewHash) this.#hashCount++;
        const narrowFn = this.#deps.narrowFn();
        if (this.#narrowHashes && narrowFn
            && this.#narrowIndexKey === this.#deps.narrowKey()
            && narrowFn(canonicalKey) && !this.#narrowSet.has(hash)) {
            this.#narrowHashes.unshift(hash);
            this.#narrowSet.add(hash);
        }
        const total = this.#narrowHashes ? this.#narrowHashes.length : this.#hashCount;
        this.#pageCount = Math.max(1, Math.ceil(total / this.#pageSize));
    }

    // A disk prune deleted `n` hash records: keep the count/page-count in sync.
    // Returns true when the current page fell off the end (caller reloads the
    // new last page so the snapshot matches the pager).
    dropHashes(n) {
        this.#hashCount = Math.max(0, this.#hashCount - n);
        this.#pageCount = Math.max(1, Math.ceil(Math.max(1, this.#hashCount) / this.#pageSize));
        return this.#page > this.#pageCount - 1;
    }

    // True (once) when the narrowing key changed since the last load/check —
    // the caller then repaginates from page 0.
    narrowKeyChanged() {
        const key = this.#deps.narrowKey();
        if (key === this.#narrowKeyApplied) return false;
        this.#narrowKeyApplied = key;
        return true;
    }

    // The snapshot ages as time passes; after a wide-view rebuild the caller
    // rewinds the tail boundary to the pre-rebuild instant so the live tail
    // and the rebuilt caches can't leave a gap (overlap is safe — rows dedupe
    // by hash in the render merge).
    rewindCacheAt(t) { if (t < this.#cacheAt) this.#cacheAt = t; }

    // ---- disk loads ----------------------------------------------------------

    // Load one page from disk: the newest `pageSize` hashes (by firstSeen,
    // within the Display window) and all their observations, assembled into
    // recent-window-shaped entries so the renderer treats both sides the same.
    async loadPage(page, reset = false) {
        if (!this.#model.ready) return;
        await this.#model.flush();   // the page must include still-buffered packets
        const boundary = Date.now(); // snapshot covers disk up to here (tail base)
        if (reset) {
            this.#page = 0;
            // The underlying data may have changed (replay/import/prune/narrow
            // change) — any narrow index is stale.
            this.#narrowHashes = this.#narrowSet = null;
        }
        const size = this.#pageSize;
        const winFrom = this.#deps.displayCutoff() || undefined;
        // Authoritative count from disk; between loads it is maintained in RAM
        // (noteIngest) so the pager needs no disk reads.
        this.#hashCount = await this.#model.countHashes(winFrom);
        this.#narrowKeyApplied = this.#deps.narrowKey();
        const narrowed = this.#deps.narrowFn() != null;
        if (narrowed && !this.#narrowHashes) await this.#buildNarrowIndex();
        if (!narrowed) this.#narrowHashes = this.#narrowSet = null;
        // A concurrent narrowing change can make #buildNarrowIndex bail (leaving
        // null); treat as empty — the follow-up repaginate re-renders.
        const narrowHashes = narrowed ? (this.#narrowHashes ?? []) : null;
        const total = narrowed ? narrowHashes.length : this.#hashCount;
        this.#pageCount = Math.max(1, Math.ceil(total / size));
        this.#page = Math.min(Math.max(0, page), this.#pageCount - 1);
        const hashes = narrowed
            ? await this.#model.getHashes(narrowHashes.slice(this.#page * size, (this.#page + 1) * size))
            : await this.#model.pageHashes(this.#page * size, size, winFrom);
        const map = new Map();
        for (const h of hashes) {
            const obs = await this.#model.obsForHash(h.hash);
            if (!obs.length) continue;
            const repeaters = new Map();
            let firstSeen = h.firstSeen ?? Infinity, lastSeen = 0;
            for (const o of obs) {
                const col = this.#deps.resolveCol(o.rawId);
                const rep = { snr: o.snr, rssi: o.rssi, rawHex: o.rawHex, rawId: o.rawId,
                              time: o.time, lat: o.lat, lon: o.lon, remoteSnr: o.remoteSnr, packet: null };
                // Keep the strongest-RSSI observation per column (matches live merge intent).
                const prev = repeaters.get(col);
                if (!prev || (rep.rssi != null && (prev.rssi == null || rep.rssi > prev.rssi))) repeaters.set(col, rep);
                if (o.time < firstSeen) firstSeen = o.time;
                if (o.time > lastSeen)  lastSeen  = o.time;
            }
            map.set(h.hash, { repeaters, firstSeen, lastSeen, type: h.type, meta: h.meta,
                              rawHex: obs[0].rawHex, packet: null, _stub: false });
        }
        this.#pageData = map;
        this.#cacheAt = boundary;   // rows newer than this are the live tail
        // Recompute the page-0 column counts (sort key #2) once per page-0 load,
        // so the column sort stays a cheap map read. Only for page 0: the counts
        // must always reflect the first page, so paging away keeps the last
        // page-0 values (stable column order).
        if (this.#page === 0) {
            const counts = new Map();
            for (const d of map.values()) for (const col of d.repeaters.keys()) counts.set(col, (counts.get(col) ?? 0) + 1);
            this.#firstPageColCounts = counts;
        }
    }

    // Which page a hash sits on under the current narrowing (one row per hash,
    // so it is unique). Flushes first — a just-received packet may still sit in
    // the write buffer, and the index scan is disk-only.
    async pageOfHash(hash) {
        await this.#model.flush();
        if (!this.#narrowHashes || this.#narrowIndexKey !== this.#deps.narrowKey())
            await this.#buildNarrowIndex();
        const idx = this.#narrowHashes ? this.#narrowHashes.indexOf(hash) : -1;
        return idx >= 0 ? Math.floor(idx / this.#pageSize) : 0;
    }

    // Build the narrowed hash index: every hash with at least one observation
    // from a matching repeater, newest-first by the time that repeater first
    // heard it. One chunked scan over the obs store; the rawId → matches
    // projection is memoised since rawIds repeat heavily.
    async #buildNarrowIndex() {
        // Capture the narrowing this scan is FOR. Two quick chart-point clicks on
        // different repeaters start overlapping scans; if a slower earlier scan
        // finished last it used to stamp the current (newer) key over its own
        // stale hashes, so the newer selection then paged the wrong repeater.
        const builtForKey = this.#deps.narrowKey();
        const narrowFn = this.#deps.narrowFn();
        const matchByRawId = new Map();
        const firstHeard = new Map();   // hash → earliest matching obs time
        // Scan only the Display window — the pager shows nothing older anyway.
        await this.#model.eachObs(this.#deps.displayCutoff() || -Infinity, Infinity, o => {
            let ok = matchByRawId.get(o.rawId);
            if (ok === undefined) {
                ok = narrowFn(this.#deps.resolveCol(o.rawId));
                matchByRawId.set(o.rawId, ok);
            }
            // eachObs iterates ascending time, so the first sighting is the earliest.
            if (ok && !firstHeard.has(o.hash)) firstHeard.set(o.hash, o.time);
        });
        // The narrowing changed while we scanned — our result is stale; don't
        // overwrite (or mislabel) the index the current selection is using.
        if (builtForKey !== this.#deps.narrowKey()) return;
        this.#narrowHashes = [...firstHeard.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([h]) => h);
        this.#narrowSet = new Set(this.#narrowHashes);
        this.#narrowIndexKey = builtForKey;
    }

    // Reset to the empty state (Clear data), hash count included — so the
    // empty state and the Active stat read 0 immediately instead of showing
    // stale numbers until the follow-up wide-view rebuild recounts from the
    // (just-cleared) disk.
    clear() {
        this.#pageData = new Map();
        this.#page = 0;
        this.#pageCount = 1;
        this.#hashCount = 0;
        this.#narrowHashes = this.#narrowSet = null;
        this.#narrowIndexKey = this.#narrowKeyApplied = '';
        this.#cacheAt = 0;
        this.#firstPageColCounts = new Map();
    }
}
