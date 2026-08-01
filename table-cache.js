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
    #narrowKeyApplied = '\x1f';  // combined "narrow\x1f msgFilter" key the current page was loaded for
    #textHashes = null;          // newest-first hashes matching the message filter (null = off/stale)
    #textSet = null;
    #textIndexKey = null;        // message filter the text index was built for (null = none)
    #filteredTotal = null;       // effective row total under the active filters (null = unfiltered)
    #firstPageColCounts = new Map(); // per-column occurrences on page 0 (column sort key #2)
    #loadSeq = 0;                // guards concurrent loadPage calls (newest wins wholly)

    constructor(model, { pageSize = 100, resolveCol, narrowFn, narrowKey, displayCutoff,
                         msgFilter = () => '', rowMatches = () => true }) {
        this.#model = model;
        this.#pageSize = pageSize;
        this.#deps = { resolveCol, narrowFn, narrowKey, displayCutoff, msgFilter, rowMatches };
    }

    get page()      { return this.#page; }
    get pageCount() { return this.#pageCount; }
    get hashCount() { return this.#hashCount; }
    get pageSize()  { return this.#pageSize; }
    get cacheAt()   { return this.#cacheAt; }
    get narrowed()  { return this.#narrowHashes != null; }
    get textFiltered() { return this.#textIndexKey != null; }
    // Effective row total under the active narrowing/filter (null = unfiltered).
    get filterTotal()  { return this.#filteredTotal; }
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
                // When narrowed/filtered the snapshot holds only matching hashes
                // — keep the tail consistent so hidden rows don't eat the page cap.
                if (narrowFn && ![...d.repeaters.keys()].some(narrowFn)) continue;
                const mf = this.#deps.msgFilter();
                if (mf && !this.#deps.rowMatches(d, mf)) continue;
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
        const wasInNarrow = this.#narrowSet?.has(hash) ?? false;
        if (this.#narrowHashes && narrowFn
            && this.#narrowIndexKey === this.#deps.narrowKey()
            && narrowFn(canonicalKey) && !this.#narrowSet.has(hash)) {
            this.#narrowHashes.unshift(hash);
            this.#narrowSet.add(hash);
        }
        // Text index: a live packet can join it too. Match on the RAM row (it
        // was just ingested there); guard on the index being current.
        const wasInText = this.#textSet?.has(hash) ?? false;
        if (this.#textHashes && this.#textIndexKey === this.#deps.msgFilter()
            && !this.#textSet.has(hash)) {
            const row = this.#model.recentGet(hash);
            if (row && this.#deps.rowMatches(row, this.#textIndexKey)) {
                this.#textHashes.unshift(hash);
                this.#textSet.add(hash);
            }
        }
        // Keep the effective total in step: the hash counts when it satisfies
        // every ACTIVE filter and was not already counted. (Exact totals are
        // re-established on each loadPage; this keeps the pager live between.)
        if (this.#filteredTotal != null) {
            const inNarrow = !this.#narrowHashes || this.#narrowSet.has(hash);
            const inText   = !this.#textHashes   || this.#textSet.has(hash);
            const wasCounted = (this.#narrowHashes ? wasInNarrow : true)
                            && (this.#textHashes ? wasInText : true)
                            && !isNewHash;
            if (inNarrow && inText && !wasCounted) this.#filteredTotal++;
        }
        const total = this.#filteredTotal
            ?? (this.#narrowHashes ? this.#narrowHashes.length : this.#hashCount);
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

    // True (once) when the combined filter key (repeater narrowing + message
    // filter) changed since the last load/check — the caller then repaginates
    // from page 0.
    narrowKeyChanged() {
        const key = this.#deps.narrowKey() + '\x1f' + this.#deps.msgFilter();
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
        // Callers fire loadPage without awaiting (pager clicks, the prune tick,
        // narrowing changes), so two loads can be in flight at once. Everything
        // is computed into locals and committed at the end only when this is
        // still the NEWEST call — otherwise an older, slower load finishing
        // last would overwrite the newer page (pager saying one page, snapshot
        // holding another).
        const seq = ++this.#loadSeq;
        await this.#model.flush();   // the page must include still-buffered packets
        const boundary = Date.now(); // snapshot covers disk up to here (tail base)
        if (reset) {
            // The underlying data may have changed (replay/import/prune/filter
            // change) — any filter index is stale.
            this.#narrowHashes = this.#narrowSet = null;
            this.#textHashes = this.#textSet = null;
            this.#textIndexKey = null;
        }
        const size = this.#pageSize;
        const winFrom = this.#deps.displayCutoff() || undefined;
        // Authoritative count from disk; between loads it is maintained in RAM
        // (noteIngest) so the pager needs no disk reads.
        const hashCount = await this.#model.countHashes(winFrom);
        const narrowKeyApplied = this.#deps.narrowKey() + '\x1f' + this.#deps.msgFilter();
        const narrowed = this.#deps.narrowFn() != null;
        if (narrowed && !this.#narrowHashes) await this.#buildNarrowIndex();
        const msgFilter = this.#deps.msgFilter();
        if (msgFilter && this.#textIndexKey !== msgFilter) await this.#buildTextIndex();
        if (!msgFilter) { this.#textHashes = this.#textSet = null; this.#textIndexKey = null; }
        // Effective hash list under the active filters. A concurrent filter
        // change can make an index build bail (leaving null); treat as empty —
        // the follow-up repaginate re-renders.
        const narrowHashes = narrowed ? (this.#narrowHashes ?? []) : null;
        const textSet = msgFilter ? (this.#textSet ?? new Set()) : null;
        let listed = null;
        if (narrowHashes && textSet) listed = narrowHashes.filter(h => textSet.has(h));
        else if (narrowHashes)       listed = narrowHashes;
        else if (textSet)            listed = msgFilter ? (this.#textHashes ?? []) : null;
        const total = listed ? listed.length : hashCount;
        const pageCount = Math.max(1, Math.ceil(total / size));
        const pageNum = Math.min(Math.max(0, page), pageCount - 1);
        const hashes = listed
            ? await this.#model.getHashes(listed.slice(pageNum * size, (pageNum + 1) * size))
            : await this.#model.pageHashes(pageNum * size, size, winFrom);
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
        // A newer loadPage started while this one was reading disk — drop this
        // result whole rather than committing a stale snapshot over the new one.
        if (seq !== this.#loadSeq) return;
        this.#hashCount = hashCount;
        this.#narrowKeyApplied = narrowKeyApplied;
        if (!narrowed) this.#narrowHashes = this.#narrowSet = null;
        this.#filteredTotal = listed ? total : null;
        this.#pageCount = pageCount;
        this.#page = pageNum;
        this.#pageData = map;
        this.#cacheAt = boundary;   // rows newer than this are the live tail
        // Recompute the page-0 column counts (sort key #2) once per page-0 load,
        // so the column sort stays a cheap map read. Only for page 0: the counts
        // must always reflect the first page, so paging away keeps the last
        // page-0 values (stable column order).
        if (pageNum === 0) {
            const counts = new Map();
            for (const d of map.values()) for (const col of d.repeaters.keys()) counts.set(col, (counts.get(col) ?? 0) + 1);
            this.#firstPageColCounts = counts;
        }
    }

    // Which page a hash sits on under the current narrowing + message filter
    // (one row per hash, so it is unique). Flushes first — a just-received
    // packet may still sit in the write buffer, and the index scans are
    // disk-only.
    async pageOfHash(hash) {
        await this.#model.flush();
        const narrowed = this.#deps.narrowFn() != null;
        if (narrowed && (!this.#narrowHashes || this.#narrowIndexKey !== this.#deps.narrowKey()))
            await this.#buildNarrowIndex();
        if (!narrowed) this.#narrowHashes = this.#narrowSet = null;
        const msgFilter = this.#deps.msgFilter();
        if (msgFilter && this.#textIndexKey !== msgFilter) await this.#buildTextIndex();
        let listed = this.#narrowHashes;
        if (msgFilter && this.#textSet) {
            listed = listed ? listed.filter(h => this.#textSet.has(h)) : (this.#textHashes ?? []);
        }
        const idx = listed ? listed.indexOf(hash) : -1;
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

    // Build the message-filter index: every hash whose ROW — type, meta, raw
    // bytes, repeater ids (and through the injected matcher also contact
    // names) — matches the active text filter, newest-first by firstSeen. One
    // pass over the hash records plus one over the obs store: the same cost
    // class as the repeater narrow index. Assembles a minimal row shape per
    // hash and delegates the actual matching to deps.rowMatches, so the
    // matching semantics live in ONE place (the app's _rowMatchesFilter) for
    // both the live tail and the disk index.
    async #buildTextIndex() {
        // Capture the filter this scan is FOR — a filter change mid-scan makes
        // the result stale (same overlap guard as the narrow index).
        const builtFor = this.#deps.msgFilter();
        const winFrom = this.#deps.displayCutoff() || -Infinity;
        const shapes = new Map();   // hash → row shape for deps.rowMatches
        await this.#model.eachHash(winFrom, h => {
            shapes.set(h.hash, { type: h.type, meta: h.meta, firstSeen: h.firstSeen,
                                 rawHex: null, repeaters: new Map() });
        });
        const colOf = new Map();    // rawId → col (memoised; rawIds repeat heavily)
        await this.#model.eachObs(winFrom === -Infinity ? -Infinity : winFrom, Infinity, o => {
            const s = shapes.get(o.hash);
            if (!s) return;
            let col = colOf.get(o.rawId);
            if (col === undefined) { col = this.#deps.resolveCol(o.rawId); colOf.set(o.rawId, col); }
            if (!s.repeaters.has(col)) s.repeaters.set(col, { rawId: o.rawId });
            if (!s.rawHex && o.rawHex) s.rawHex = o.rawHex;
        });
        if (builtFor !== this.#deps.msgFilter()) return;   // stale — a newer filter owns the index
        const matched = [];
        for (const [hash, s] of shapes) {
            if (this.#deps.rowMatches(s, builtFor)) matched.push([hash, s.firstSeen ?? 0]);
        }
        matched.sort((a, b) => b[1] - a[1]);
        this.#textHashes = matched.map(([h]) => h);
        this.#textSet = new Set(this.#textHashes);
        this.#textIndexKey = builtFor;
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
        this.#narrowIndexKey = '';
        this.#narrowKeyApplied = '\x1f';
        this.#textHashes = this.#textSet = null;
        this.#textIndexKey = null;
        this.#filteredTotal = null;
        this.#cacheAt = 0;
        this.#firstPageColCounts = new Map();
    }
}
