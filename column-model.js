// ColumnModel — the stateful half of the repeater-column system, extracted from
// app.js. The PURE semantics (prefix resolution, collision keys, promote/merge
// events) already live in column-key.js; this class owns the STATE those events
// act on, previously three loose fields mutated from five different flows:
//
//   • the ordered column list (#columns) — Seen Repeaters rows / table columns;
//   • the per-column session stats (#stats: lastSeen, count, max/last SNR+RSSI,
//     minPrecision) — updated at live ingest, recomputed after prunes, widened
//     from the disk chart cache;
//   • the per-column colour seeds (#seeds) — a deterministic FNV-1a hash of the
//     display id, cached (dropping a seed never changes the colour).
//
// Column LIFECYCLE (resolve → add/rename/split) runs through here, so the array
// can't be mutated ad hoc any more. View-side retagging (chart points, the
// recent window, the 3D map, open table rows, the selection) stays in app.js,
// driven by the onRename/onSplit hooks. Unit-tested with stub hooks in
// test/column-model.test.js.

import * as ColumnKey from './column-key.js?v=2';

export class ColumnModel {
    #columns = [];
    #stats = new Map();
    #seeds = new Map();
    #deps;   // { displayId, onRename(oldKey, newKey), onSplit(existingCol, collisionKey, existingPrec) }

    constructor(deps) { this.#deps = deps; }

    // The ordered column list. TREAT AS READ-ONLY — all mutations go through
    // resolve/add/remove/rename/sort so the five owning flows stay in one place.
    get list()  { return this.#columns; }
    get count() { return this.#columns.length; }
    has(col)    { return this.#columns.includes(col); }

    stats(col)     { return this.#stats.get(col); }
    statsEntries() { return this.#stats.entries(); }

    add(col) { if (!this.#columns.includes(col)) this.#columns.push(col); }

    // Drop a column with its stats and colour seed (prune dissolve).
    remove(col) {
        const idx = this.#columns.indexOf(col);
        if (idx >= 0) this.#columns.splice(idx, 1);
        this.#stats.delete(col);
        this.#seeds.delete(col);
    }

    clear() {
        this.#columns = [];
        this.#stats.clear();
        this.#seeds.clear();
    }

    // Resolve a raw path id to its canonical column, applying the promote/
    // merge/split events column-key.js decides on (was findOrCreateColumn).
    resolve(rawId) {
        const { key, events } = ColumnKey.resolveColumn(
            rawId, this.#columns, col => this.#stats.get(col)?.minPrecision);
        for (const ev of events) {
            if (ev.type === 'rename') this.rename(ev.from, ev.to);
            else if (ev.type === 'split') this.#split(ev.existing, ev.collisionKey);
            else if (ev.type === 'add') this.add(ev.key);
        }
        return key;
    }

    // Rename/merge a column: replaces it in the list (or merges into an already
    // existing target), merges the stats (totals add up, "last" values follow
    // the newer side), drops the stale colour seed, then lets the app retag its
    // views via onRename.
    rename(oldKey, newKey) {
        if (oldKey === newKey) return;
        const oldIdx = this.#columns.indexOf(oldKey);
        if (oldIdx < 0) return;
        const newIdx = this.#columns.indexOf(newKey);
        if (newIdx >= 0) this.#columns.splice(oldIdx, 1);
        else             this.#columns[oldIdx] = newKey;

        const oldData = this.#stats.get(oldKey);
        if (oldData) {
            const newData = this.#stats.get(newKey);
            if (newData) {
                const newer = oldData.lastSeen >= newData.lastSeen ? oldData : newData;
                const mergeMax = (a, b) => a == null ? b : b == null ? a : Math.max(a, b);
                this.#stats.set(newKey, {
                    lastSeen:     Math.max(oldData.lastSeen, newData.lastSeen),
                    count:        oldData.count + newData.count,
                    maxSnr:       mergeMax(oldData.maxSnr,  newData.maxSnr),
                    maxRssi:      mergeMax(oldData.maxRssi, newData.maxRssi),
                    lastSnr:      newer.lastSnr,
                    lastRssi:     newer.lastRssi,
                    minPrecision: Math.min(
                        oldData.minPrecision ?? ColumnKey.idPrecision(ColumnKey.colHead(oldKey)),
                        newData.minPrecision ?? ColumnKey.idPrecision(ColumnKey.colHead(newKey)),
                    ),
                });
            } else {
                this.#stats.set(newKey, oldData);
            }
            this.#stats.delete(oldKey);
        }
        this.#seeds.delete(oldKey);
        this.#deps.onRename(oldKey, newKey);
    }

    // Un-merge: register the collision column, then let the app move the
    // ambiguous (shorter-precision) entries over and refresh both stats.
    #split(existingCol, collisionKey) {
        this.add(collisionKey);
        this.#deps.onSplit(existingCol, collisionKey, ColumnKey.idPrecision(existingCol));
    }

    // Fold one live observation into the column's session stats (ingest path).
    noteObservation(col, rawId, now, snr, rssi) {
        const rawPrec  = ColumnKey.idPrecision(rawId);
        const existing = this.#stats.get(col);
        this.#stats.set(col, {
            lastSeen:     now,
            count:        (existing?.count ?? 0) + 1,
            maxSnr:  snr  != null ? Math.max(existing?.maxSnr  ?? -Infinity, snr)  : (existing?.maxSnr  ?? null),
            maxRssi: rssi != null ? Math.max(existing?.maxRssi ?? -Infinity, rssi) : (existing?.maxRssi ?? null),
            lastSnr:  snr  != null ? snr  : (existing?.lastSnr  ?? null),
            lastRssi: rssi != null ? rssi : (existing?.lastRssi ?? null),
            minPrecision: Math.min(existing?.minPrecision ?? rawPrec, rawPrec),
        });
    }

    // Recompute a column's stats from the given (RAM-window) points; a column
    // with no points left is removed entirely.
    recomputeFromPoints(col, points) {
        let count = 0, lastSeen = -1, maxSnr = null, maxRssi = null;
        let lastSnr = null, lastRssi = null, minPrec = Infinity;
        for (const p of points) {
            if (p.col !== col) continue;
            count++;
            if (p.time > lastSeen) {
                lastSeen = p.time;
                lastSnr  = p.snr;
                lastRssi = p.rssi;
            }
            if (p.snr  != null && (maxSnr  == null || p.snr  > maxSnr))  maxSnr  = p.snr;
            if (p.rssi != null && (maxRssi == null || p.rssi > maxRssi)) maxRssi = p.rssi;
            if (p.rawId) {
                const r = ColumnKey.idPrecision(p.rawId);
                if (r < minPrec) minPrec = r;
            }
        }
        if (count === 0) {
            this.#stats.delete(col);
            const idx = this.#columns.indexOf(col);
            if (idx >= 0) this.#columns.splice(idx, 1);
            return;
        }
        if (!Number.isFinite(minPrec)) minPrec = ColumnKey.idPrecision(ColumnKey.colHead(col));
        this.#stats.set(col, {
            lastSeen, count, maxSnr, maxRssi, lastSnr, lastRssi,
            minPrecision: minPrec,
        });
    }

    // Widen the live stats from a per-column disk aggregate (the Display-window
    // chart cache): live entries keep their exact "last" values and only grow
    // their totals; columns known only from disk are (re)added whole. Returns
    // whether anything changed (the caller re-renders then).
    mergeDiskAggregates(agg) {
        let changed = false;
        for (const [col, a] of agg) {
            const live = this.#stats.get(col);
            if (live) {
                if (a.count > live.count) { live.count = a.count; changed = true; }
                if (a.maxSnr  != null && (live.maxSnr  == null || a.maxSnr  > live.maxSnr))  { live.maxSnr  = a.maxSnr;  changed = true; }
                if (a.maxRssi != null && (live.maxRssi == null || a.maxRssi > live.maxRssi)) { live.maxRssi = a.maxRssi; changed = true; }
                continue;
            }
            if (!Number.isFinite(a.minPrecision)) a.minPrecision = ColumnKey.idPrecision(ColumnKey.colHead(col));
            this.#stats.set(col, a);
            this.add(col);
            changed = true;
        }
        return changed;
    }

    // Order the columns for display: recent activity, then first-page presence,
    // then last RSSI, last SNR, total count, name.
    sort({ recentCount, pageCounts }) {
        this.#columns.sort((a, b) => {
            const ra = recentCount.get(a) ?? 0;
            const rb = recentCount.get(b) ?? 0;
            if (rb !== ra) return rb - ra;
            const pa = pageCounts.get(a) ?? 0;
            const pb = pageCounts.get(b) ?? 0;
            if (pb !== pa) return pb - pa;
            const da = this.#stats.get(a);
            const db = this.#stats.get(b);
            const lrA = da?.lastRssi ?? -Infinity;
            const lrB = db?.lastRssi ?? -Infinity;
            if (lrB !== lrA) return lrB - lrA;
            const lsA = da?.lastSnr ?? -Infinity;
            const lsB = db?.lastSnr ?? -Infinity;
            if (lsB !== lsA) return lsB - lsA;
            const cA = da?.count ?? 0;
            const cB = db?.count ?? 0;
            if (cB !== cA) return cB - cA;
            return a.localeCompare(b);
        });
    }

    // Stable 32-bit FNV-1a hash of the column's display id, memoised — the
    // colour-picking seed. Deterministic in the id, so cache lifetime is purely
    // a perf detail.
    colorSeed(col) {
        if (!this.#seeds.has(col)) {
            const id = this.#deps.displayId(col);
            let h = 0x811c9dc5;
            for (let i = 0; i < id.length; i++) {
                h ^= id.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            this.#seeds.set(col, h >>> 0);
        }
        return this.#seeds.get(col);
    }
}
