// MapCache — the 3D map's spatial cell cache, extracted from app.js so its
// layers are #private and every read goes through a named method. The map
// renders from an in-RAM cell cache (per-repeater spatial grid); disk is read
// only to BUILD a layer — never periodically:
//
//  - BASE: a coarse grid over the FULL extent, built once per Display window
//    (and when the dot budget overflows). New packets upsert their cell
//    directly in RAM, so the map is current without any rescan. Because a
//    cell's representative is its MOST RECENT observation, expiry is exact:
//    when the representative leaves a finite Display window the whole cell is
//    provably empty and is dropped (push() purges the Map).
//  - DETAIL: when zoomed into a sub-region, a finer grid for the visible bbox
//    only (cheap — Morton-indexed), rebuilt on view change. Live packets
//    inside the bbox upsert this layer too. Clustering is DENSITY-driven: the
//    viewport is queried at the finest (raw) level and only coarsened while
//    the dot count exceeds the budget.
//
// App-level concerns are injected (deps): column resolution, the Display
// window, the current map view (for the dot-budget escape valve), and the two
// push hooks that hand the merged points / sent points to the Three.js map.
// The model (CaptureModel) supplies disk reads.

import * as MapLod from './maplod.js?v=4';

export class MapCache {
    #model;
    #deps;               // { resolveCol, displayLifetime, displayCutoff, lastView, pushPoints, pushSentPoints }
    #targetDots;
    #base = null;        // full-extent layer {cells: Map, cell, at}
    #detail = null;      // finer layer for the zoomed-in bbox {cells, cell, bbox}
    #key = null;         // identity of the last applied view (skip same-view re-query)
    #req = 0;            // monotonic token so only the latest concurrent refresh commits
    #detailLevel = null; // current LOD pyramid level of the detail layer (hysteresis state)
    #sentVer = -1;       // dataVer the outgoing-SNR layer was loaded for
    #pending = null;     // packets ingested before the base layer exists
    #pushTimer = null;   // coalesces cell upserts into one geometry push
    #rebuildBusy = false;// guards the dot-budget escape-valve rebuild

    constructor(model, { targetDots = 2500, ...deps } = {}) {
        this.#model = model;
        this.#targetDots = targetDots;
        this.#deps = deps;
    }

    // Cell identity for RAM upserts. Shares the one LOD binning (maplod.cellKey)
    // with the disk-built layers (gridObs is fed maplod.cellIndices), so they
    // agree on which cell a point belongs to.
    #cellKey(cellMeters, rawId, lat, lon) {
        return MapLod.cellKey(cellMeters, rawId, lat, lon);
    }

    #cellsFrom(arr, cellMeters) {
        const m = new Map();
        for (const r of arr) m.set(this.#cellKey(cellMeters, r.rawId, r.lat, r.lon), r);
        return m;
    }

    // Fold one live observation into the RAM cell layers. The new point is by
    // definition the newest in its cell, so it always becomes the representative.
    upsert(o) {
        const base = this.#base;
        if (!base) {   // layers not built yet (startup race) — apply after build
            (this.#pending ??= []).length < 1000 && this.#pending.push(o);
            return;
        }
        // First-ever point: seed the cell at the same rung a disk rebuild of a
        // tiny extent would pick — cellFor's 5 m floor snapped onto the 2·2ⁿ
        // ladder (= 4 m, level 1). A raw off-ladder 5 here silently broke the
        // "base nests with the detail levels" invariant (refresh() derives
        // baseLevel by rounding, so the gate compared against a 4 m level while
        // the real bin was 5 m) until a budget-overflow rebuild re-snapped it.
        if (!base.cell) base.cell = MapLod.cellMetersForLevel(MapLod.levelForCellMeters(5));
        const bKey = this.#cellKey(base.cell, o.rawId, o.lat, o.lon);
        base.cells.set(bKey, { ...o, count: (base.cells.get(bKey)?.count ?? 0) + 1 });
        const d = this.#detail;
        if (d && o.lat >= d.bbox.minLat && o.lat <= d.bbox.maxLat
              && o.lon >= d.bbox.minLon && o.lon <= d.bbox.maxLon) {
            const dKey = this.#cellKey(d.cell, o.rawId, o.lat, o.lon);
            d.cells.set(dKey, { ...o, count: (d.cells.get(dKey)?.count ?? 0) + 1 });
        }
        // Walking into new territory at the 5 m floor can blow the dot budget —
        // rebuild the base once with a properly sized cell when it does.
        if (base.cells.size > this.#targetDots * 3 && !this.#rebuildBusy) {
            this.#rebuildBusy = true;
            this.#base = null;
            const lv = this.#deps.lastView();
            this.refresh(lv?.bbox ?? null, lv?.mpp ?? null)
                .finally(() => { this.#rebuildBusy = false; });
            return;
        }
        this.schedulePush();
    }

    // Hand the merged cell layers to the map, coalesced so a packet burst costs
    // one geometry rebuild. Also purges cells that left a finite Display window
    // (exact — see header comment).
    schedulePush() {
        if (this.#pushTimer) return;
        this.#pushTimer = setTimeout(() => { this.#pushTimer = null; this.push(); }, 200);
    }

    push() {
        const base = this.#base;
        if (!base) return;
        const cutoff = this.#deps.displayCutoff();
        if (cutoff) {
            for (const [k, p] of base.cells) if (p.time < cutoff) base.cells.delete(k);
            const d = this.#detail;
            if (d) for (const [k, p] of d.cells) if (p.time < cutoff) d.cells.delete(k);
        }
        const d = this.#detail;
        let merged;
        if (d) {
            const inB = p => p.lat >= d.bbox.minLat && p.lat <= d.bbox.maxLat
                          && p.lon >= d.bbox.minLon && p.lon <= d.bbox.maxLon;
            merged = [...base.cells.values()].filter(p => !inB(p)).concat([...d.cells.values()]);
        } else {
            merged = [...base.cells.values()];
        }
        this.#deps.pushPoints(merged.map(r => ({
            lat: r.lat, lon: r.lon, snr: r.snr, rssi: r.rssi, time: r.time,
            rawId: r.rawId, col: this.#deps.resolveCol(r.rawId), count: r.count,
        })));
    }

    async refresh(bbox = null, mpp = null) {
        if (!this.#model.ready) return;
        // This runs concurrently (import/fit refresh + user zoom/pan), and each
        // call is a slow chain of disk queries. Without a guard the SLOWER call
        // (a bigger region) finishes last and overwrites the newer call's finer
        // result — so after zooming you keep seeing the coarse "fit" grid until
        // some later event (app switch) fires a fresh, uncontested refresh.
        // Stamp each call; only the latest one commits its result.
        const myReq = ++this.#req;
        const lifetime = this.#deps.displayLifetime();
        const from = isFinite(lifetime) ? Date.now() - lifetime : -Infinity;
        const TARGET_DOTS = this.#targetDots;
        // sqrt(area / target) spreads ~TARGET_DOTS cells across the extent.
        const cellFor = (minLat, maxLat, minLon, maxLon) => {
            const midLat = (minLat + maxLat) / 2;
            const latM = Math.max(1, (maxLat - minLat) * 111320);
            const lonM = Math.max(1, (maxLon - minLon) * 111320 * Math.cos(midLat * Math.PI / 180));
            return Math.max(5, Math.sqrt((latM * lonM) / TARGET_DOTS));
        };
        try {
            // Outgoing (sent) SNR is low-volume and has no spatial index, so load
            // the whole window when (re)building; live ones arrive via the sent
            // tail in signal3d.
            if (this.#sentVer !== this.#model.dataVer) {
                const sentPts = [];
                await this.#model.eachSent(from, Infinity, r => {
                    if (r.lat == null || r.lon == null) return;
                    sentPts.push({ lat: r.lat, lon: r.lon, snr: r.snr, time: r.time,
                                   rawId: r.rawId, col: this.#deps.resolveCol(r.rawId) });
                });
                this.#deps.pushSentPoints(sentPts);
                this.#sentVer = this.#model.dataVer;
            }
            // Build the base layer only when absent (Display change drops it).
            // Freshness and expiry are handled in RAM — no periodic rescan.
            if (!this.#base) {
                await this.#model.flush();   // the disk build must include everything buffered
                const s = await this.#model.regionStats(from, Infinity, null);
                if (s.count) {
                    // Snap the coarse full-extent cell onto the LOD ladder so the
                    // base nests with the detail levels and stays stable.
                    const cell = MapLod.cellMetersForLevel(
                        MapLod.levelForCellMeters(cellFor(s.minLat, s.maxLat, s.minLon, s.maxLon)));
                    const pts = await this.#model.gridObs(from, Infinity, (lat, lon) => MapLod.cellIndices(cell, lat, lon), null);
                    this.#base = { cells: this.#cellsFrom(pts, cell), cell, at: Date.now() };
                } else {
                    this.#base = { cells: new Map(), cell: 0, at: Date.now() };
                }
                this.#key = null;
                // Packets that arrived while there was no base yet (startup race)
                const pend = this.#pending;
                this.#pending = null;
                if (pend) for (const o of pend) this.upsert(o);
            }
            const base = this.#base;
            const baseLevel = base.cell ? MapLod.levelForCellMeters(base.cell) : Infinity;
            // Detail layer for the current view, over a bbox padded so the
            // coarse/fine seam sits off-screen. Clustering here is DENSITY-driven,
            // not zoom-driven: we query the viewport at the finest (raw) level and
            // only coarsen if the dot count would blow the budget. So a sparse view
            // (e.g. a single A→B track of a few dozen points) shows every point and
            // stops re-clustering as you zoom — the pixel-based level only decides
            // *whether* a finer-than-base layer is worth building at all.
            const PAD = 0.5;
            let detailBbox = null;
            if (bbox && base.cells.size && mpp > 0) {
                const gateLvl = MapLod.pickDetailLevel(mpp, this.#detailLevel);
                this.#detailLevel = gateLvl;   // remember for hysteresis
                if (gateLvl < baseLevel) {     // zoomed in past the base → detail helps
                    const padLat = (bbox.maxLat - bbox.minLat) * PAD;
                    const padLon = (bbox.maxLon - bbox.minLon) * PAD;
                    detailBbox = { minLat: bbox.minLat - padLat, maxLat: bbox.maxLat + padLat,
                                   minLon: bbox.minLon - padLon, maxLon: bbox.maxLon + padLon };
                }
            }
            // Skip the disk re-query when the same region is already loaded. The
            // bbox is keyed at ~100 m, so small pans within a cell don't re-query;
            // the globally-aligned cells are identical across refreshes regardless.
            const key = detailBbox
                ? `${base.at}|det|`
                  + [detailBbox.minLat, detailBbox.maxLat, detailBbox.minLon, detailBbox.maxLon].map(v => Math.round(v * 1e3)).join(',')
                : `${base.at}|base`;
            if (key === this.#key) return;
            let detail = null;
            if (detailBbox) {
                await this.#model.flush();   // fine grid must include the freshest packets
                // One fine (raw) query over the viewport; step up levels only while
                // the count exceeds the budget. Coarsening the raw cells is exact
                // (see MapLod.coarsenCells), so this equals querying that level.
                let lvl = 0, cell = MapLod.cellMetersForLevel(0);
                let arr = await this.#model.gridObs(from, Infinity, (lat, lon) => MapLod.cellIndices(cell, lat, lon), detailBbox);
                while (arr.length > this.#targetDots && lvl + 1 < baseLevel) {
                    lvl++; cell = MapLod.cellMetersForLevel(lvl);
                    arr = MapLod.coarsenCells(arr, cell);
                }
                detail = { cells: this.#cellsFrom(arr, cell), cell, bbox: detailBbox };
            }
            // A newer refresh superseded us while we queried — don't clobber its
            // (finer) result with this stale one.
            if (myReq !== this.#req) return;
            this.#detail = detail;
            this.push();
            this.#key = key;
        } catch (e) {
            console.warn('Wide-map load failed:', e);
        }
    }

    // Display window changed: the layers are for the old window — drop them so
    // the follow-up refresh rebuilds the base over the new extent.
    dropLayers() {
        this.#base = null;
        this.#detail = null;
        this.#key = null;
    }

    clear() {
        this.#base = null;
        this.#detail = null;
        this.#key = null;
        this.#sentVer = -1;
        this.#detailLevel = null;
        this.#pending = null;
        clearTimeout(this.#pushTimer); this.#pushTimer = null;
    }
}
