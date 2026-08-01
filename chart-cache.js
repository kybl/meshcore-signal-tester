// ChartCache — the 2D charts' time-bucket cache, extracted from app.js so its
// layers are #private and every read goes through a named method. Same model as
// the 3D map's cell cache: an in-RAM Map of time buckets (key `rawId|bIdx`),
// kept current by folding each live packet into its bucket (upsert). Time
// buckets expire exactly — a bucket covers a fixed range, so once its end
// leaves a finite Display window it is provably empty and is dropped. Disk is
// read only to BUILD a layer:
//   - base:  once per Display window (and a growth escape valve for "All"),
//   - zoom:  on zoom-in / zoom-window change (finer buckets over the window).
// Zooming OUT needs no disk at all — the base stays maintained by upserts.
//
// App-level concerns are injected (deps): column resolution/seeding, id
// precision, the Display window and frozen clock, the current zoom window, and
// the "derived" / "base rebuilt" hooks the app uses to re-render and re-seed
// Seen Repeaters. The model (CaptureModel) supplies disk reads.

export class ChartCache {
    #model;
    #deps;           // { resolveCol, idPrecision, displayCutoff, displayLifetime,
                     //   frozenAt, zoomWindow, seedColumn, onDerived, afterBaseBuild }
    #bucketCount;
    #base = null;            // incremental time-bucket cache {cells: Map, width, lo}
    #zoomLayer = null;       // finer buckets over the zoom window {cells, width, lo, from, to}
    #renderPoints = [];      // chart render array, derived from the active layer
    #sentPoints = [];        // outgoing-SNR layer (disk) — live tail lives in the app
    #sentAt = 0;             // time the sent layer reflects
    #arrTimer = null;        // coalesces bucket upserts into one array rebuild
    #building = false;       // a rebuildBase() is in flight (self-heal guard)
    #healAt = 0;             // last self-heal attempt, to debounce retries

    constructor(model, { bucketCount = 1500, ...deps } = {}) {
        this.#model = model;
        this.#bucketCount = bucketCount;
        this.#deps = deps;
    }

    get hasBase() { return this.#base != null; }
    get sentAt()  { return this.#sentAt; }
    renderPoints() { return this.#renderPoints; }
    sentPoints()   { return this.#sentPoints; }

    // Re-establish the wide/All bucket cache if it is missing during live
    // capture. That cache is the ONLY source the charts read in a wide window,
    // and upsert() cannot fold into a null base — so if a build ever fails or is
    // dropped, nothing else would rebuild it until the next Display change,
    // freezing the charts while disk and the 3D map keep filling. Self-heal,
    // debounced and non-overlapping, so capture recovers on its own.
    ensureBase() {
        if (!this.#model.ready || this.#building) return;
        if (Date.now() - this.#healAt < 1000) return;
        this.#healAt = Date.now();
        this.#building = true;
        this.rebuildBase().finally(() => { this.#building = false; });
    }

    async rebuildBase() {
        if (!this.#model.ready) return;
        // Standalone callers (escape valve, self-heal) may have unflushed writes;
        // flush so the rebuilt base includes the packets that triggered it.
        await this.#model.flush();
        // Pin the window this build is for; if Display changes while we await disk
        // a newer build owns the base, so discard this (possibly different-window)
        // result rather than clobbering it.
        const lifetime = this.#deps.displayLifetime();
        // Bucket over the same window the charts actually render: [from, nowRef].
        // nowRef is the frozen chart clock (import / paused) or live now. Bounding
        // the upper edge matters because bucketObs derives the bucket width from
        // the queried span: with an unbounded `to`, any obs newer than nowRef
        // would stretch the width, collapsing all in-view points into a couple of
        // buckets. Using nowRef for `from` too keeps the window consistent with
        // the frozen clock.
        const nowRef = this.#deps.frozenAt() ?? Date.now();
        const from = isFinite(lifetime) ? nowRef - lifetime : -Infinity;
        try {
            const { buckets, width, lo } = await this.#model.bucketObs(from, nowRef, this.#bucketCount);
            if (this.#deps.displayLifetime() !== lifetime) return;
            const cells = new Map();
            for (const b of buckets) cells.set(b.rawId + '|' + b.bIdx, b);
            this.#base = { cells, width, lo };
            // Seed canonical repeater columns from the disk buckets, applying the
            // same promote/merge as live ingest. Without this, a node seen at
            // several path-prefix lengths (e.g. 11 / 1122 / 112233) splits into
            // one bare column PER length whenever its live column has aged out of
            // the RAM window — the read-only resolver maps each unmatched prefix
            // to itself. Shortest-first so a short prefix promotes into the
            // longer label.
            const seedRaw = new Set();
            for (const b of cells.values()) {
                if (b.rawId && b.rawId !== 'direct' && b.rawId !== 'unknown') seedRaw.add(b.rawId);
            }
            for (const r of [...seedRaw].sort((a, c) => this.#deps.idPrecision(a) - this.#deps.idPrecision(c))) {
                this.#deps.seedColumn(r);
            }
            const sent = [];
            await this.#model.eachSent(from, nowRef, r =>
                sent.push({ time: r.time, snr: r.snr, col: this.#deps.resolveCol(r.rawId), label: r.label }));
            this.#sentPoints = sent;
            this.#sentAt = Date.now();   // live sent points after this are the tail
            this.derive();
            this.#deps.afterBaseBuild();
        } catch (e) {
            console.warn('Chart base build failed:', e);
        }
    }

    // Finer buckets over the (padded) zoom window, so zooming in reveals real
    // detail instead of magnifying the base's coarse buckets. The ±1-span pad
    // gives the decimator a neighbour point outside each edge for the
    // edge-crossing connecting lines (the clip trims the overshoot).
    async rebuildZoomLayer() {
        const z = this.#deps.zoomWindow();
        if (!z || !this.#model.ready) return;
        const zspan = z.tMax - z.tMin;
        try {
            const { buckets, width, lo } = await this.#model.bucketObs(z.tMin - zspan, z.tMax + zspan, this.#bucketCount);
            const cells = new Map();
            for (const b of buckets) cells.set(b.rawId + '|' + b.bIdx, b);
            this.#zoomLayer = { cells, width, lo, from: z.tMin - zspan, to: z.tMax + zspan };
            this.derive();
        } catch (e) {
            console.warn('Chart zoom-layer build failed:', e);
        }
    }

    dropZoomLayer() { this.#zoomLayer = null; }

    // Display window changed: both layers are for the old window — drop them so
    // the follow-up rebuild owns the base (render points stay until it lands).
    dropLayers() { this.#base = null; this.#zoomLayer = null; }

    // Fold one live observation into the bucket layers (base always, the zoom
    // layer when the time falls inside it).
    upsert(time, snr, rssi, rawId, type = null, hash = null) {
        const fold = layer => {
            const bIdx = Math.floor((time - layer.lo) / layer.width);
            const key = rawId + '|' + bIdx;
            let g = layer.cells.get(key);
            if (!g) {
                g = { rawId, bIdx, time: layer.lo + bIdx * layer.width + Math.floor(layer.width / 2),
                      count: 0, snrMin: null, snrMax: null, snrSum: 0, snrN: 0,
                      rssiMin: null, rssiMax: null, rssiSum: 0, rssiN: 0,
                      lastSnrT: -Infinity, lastSnr: null, lastRssiT: -Infinity, lastRssi: null };
                layer.cells.set(key, g);
            }
            g.count++;
            // A bucket holding exactly one reception stands for a single packet —
            // carry its exact time, type and hash (the tooltip shows ms + the type
            // badge; a chart click opens the packet's detail). A second reception
            // makes it a cluster — drop all three.
            if (g.count === 1) { g.exactTime = time; g.type = type ?? null; g.hash = hash ?? null; }
            else { g.exactTime = null; g.type = null; g.hash = null; }
            if (snr != null) {
                g.snrSum += snr; g.snrN++;
                if (g.snrMin == null || snr < g.snrMin) g.snrMin = snr;
                if (g.snrMax == null || snr > g.snrMax) g.snrMax = snr;
                if (time >= (g.lastSnrT ?? -Infinity)) { g.lastSnrT = time; g.lastSnr = snr; }
            }
            if (rssi != null) {
                g.rssiSum += rssi; g.rssiN++;
                if (g.rssiMin == null || rssi < g.rssiMin) g.rssiMin = rssi;
                if (g.rssiMax == null || rssi > g.rssiMax) g.rssiMax = rssi;
                if (time >= (g.lastRssiT ?? -Infinity)) { g.lastRssiT = time; g.lastRssi = rssi; }
            }
            return bIdx;
        };
        if (!this.#base) { this.ensureBase(); return; }   // self-heal; the point is on disk
        const bIdx = fold(this.#base);
        // "All" keeps a fixed bucket width from its build, so a long session can
        // outgrow the bucket budget — rebuild once with a wider bucket when the
        // index runs 3x past it. (Finite windows slide: the index grows but the
        // live bucket count stays ~constant via expiry, so no rebuild is needed.)
        if (!isFinite(this.#deps.displayLifetime()) && bIdx > this.#bucketCount * 3) {
            this.#base = null;
            this.ensureBase();
            return;
        }
        const zl = this.#zoomLayer;
        if (zl && time >= zl.from && time <= zl.to) fold(zl);
        this.scheduleDerive();
    }

    scheduleDerive() {
        if (this.#arrTimer) return;
        this.#arrTimer = setTimeout(() => { this.#arrTimer = null; this.derive(); }, 200);
    }

    // Derive the render array from the active bucket layer: avg point per
    // bucket, plus min/max spread once a bucket holds >1 packet. Also purges
    // base buckets that expired from a finite Display window (exact — the
    // bucket's whole time range is past the cutoff).
    derive() {
        const base = this.#base;
        if (!base) return;
        const cutoff = this.#deps.displayCutoff();
        if (cutoff) {
            for (const [k, b] of base.cells) {
                if (base.lo + (b.bIdx + 1) * base.width < cutoff) base.cells.delete(k);
            }
        }
        // Use the zoom layer only while it actually covers the current zoom
        // window — after a pan/zoom change the stale layer would be missing the
        // newly exposed range, so fall back to the (complete, coarser) base
        // until the rebuilt layer lands.
        const zl = this.#zoomLayer;
        const z = this.#deps.zoomWindow();
        const layer = (z && zl && zl.from <= z.tMin && zl.to >= z.tMax) ? zl : base;
        const cps = [];
        for (const b of layer.cells.values()) {
            const col = this.#deps.resolveCol(b.rawId);
            const snrAvg  = b.snrN  ? b.snrSum  / b.snrN  : null;
            const rssiAvg = b.rssiN ? b.rssiSum / b.rssiN : null;
            // Single-reception bucket (count 1, live-folded): expose the packet's
            // exact time and type so the tooltip can show ms + the type badge.
            // Disk-loaded or clustered buckets lack exactTime, so they fall back
            // to the bucket time and show neither.
            const single = b.count === 1 && b.exactTime != null;
            cps.push({ time: single ? b.exactTime : b.time, snr: snrAvg, rssi: rssiAvg,
                       col, rawId: b.rawId, _bucket: true, count: b.count,
                       type: single ? b.type : undefined, hash: single ? b.hash : undefined,
                       _exactTime: single });
            if (b.count > 1) {
                if (b.snrMin != null) cps.push({ time: b.time, snr: b.snrMin, rssi: b.rssiMin, col, rawId: b.rawId, _bucket: true, count: b.count });
                if (b.snrMax != null) cps.push({ time: b.time, snr: b.snrMax, rssi: b.rssiMax, col, rawId: b.rawId, _bucket: true, count: b.count });
            }
        }
        cps.sort((a, b) => a.time - b.time);
        this.#renderPoints = cps;
        this.#deps.onDerived();
    }

    // Per-column aggregate over the base buckets (count, maxes, true last
    // SNR/RSSI by their own observation times, lastSeen ≈ newest bucket time,
    // min id precision). Used to re-seed Seen Repeaters from the Display-window
    // cache after the RAM window ages out. Returns null when there is no base.
    aggregateRepeaterStats() {
        const base = this.#base;
        if (!base) return null;
        const agg = new Map();
        for (const b of base.cells.values()) {
            const col = this.#deps.resolveCol(b.rawId);
            let a = agg.get(col);
            if (!a) {
                a = { count: 0, lastSeen: -1, maxSnr: null, maxRssi: null,
                      lastSnr: null, lastRssi: null, minPrecision: Infinity,
                      _lastSnrT: -Infinity, _lastRssiT: -Infinity };
                agg.set(col, a);
            }
            a.count += b.count;
            if (b.snrMax  != null && (a.maxSnr  == null || b.snrMax  > a.maxSnr))  a.maxSnr  = b.snrMax;
            if (b.rssiMax != null && (a.maxRssi == null || b.rssiMax > a.maxRssi)) a.maxRssi = b.rssiMax;
            if (b.time > a.lastSeen) a.lastSeen = b.time;
            // True last SNR/RSSI: the newest actual reading across buckets, each
            // tracked by its own observation time, exactly as live ingestion
            // keeps the last non-null value per metric.
            if (b.lastSnr  != null && b.lastSnrT  > a._lastSnrT)  { a._lastSnrT  = b.lastSnrT;  a.lastSnr  = b.lastSnr; }
            if (b.lastRssi != null && b.lastRssiT > a._lastRssiT) { a._lastRssiT = b.lastRssiT; a.lastRssi = b.lastRssi; }
            const prec = this.#deps.idPrecision(b.rawId);
            if (prec < a.minPrecision) a.minPrecision = prec;
        }
        return agg;
    }

    clear() {
        this.#renderPoints = [];
        this.#sentPoints = [];
        this.#base = null;
        this.#zoomLayer = null;
        this.#sentAt = 0;
        clearTimeout(this.#arrTimer); this.#arrTimer = null;
    }
}
