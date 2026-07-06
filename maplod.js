// Level-of-detail pyramid for the 3D-map dot aggregation. Pure functions (no
// browser deps) so level selection and cell binning are unit-testable (see
// test/maplod.test.js).
//
// WHY: the map downsamples observations into aggregate "cells". If the cell size
// varies continuously with the exact camera view, every small pan/zoom re-bins
// every point, so clusters flicker — points constantly appear/disappear. Instead
// we put cells on a FIXED GLOBAL grid at DISCRETE, coarse (factor-2) levels — a
// tile pyramid. Panning then only reveals/hides cells at the edges; zooming
// steps cleanly between levels (with hysteresis so the level doesn't flip back
// and forth at a boundary). Levels nest (floor-based grid), so a level is a
// clean 2× coarsening of the one below.

const CELL_BASE_M   = 2;    // finest cell edge, metres (level 0) — deep zoom separates points ~2 m apart
const MAX_LEVEL     = 25;   // 2 m · 2^25 ≈ 67 000 km — covers any extent
const TARGET_CELL_PX = 16;  // aim a cell at ~this many screen px (smaller ⇒ less clustering, more dots)
const HYSTERESIS    = 0.7;  // levels of dead-band before switching (stability)

// Cell edge length in metres at a pyramid level (0 = finest).
export function cellMetersForLevel(level) {
    return CELL_BASE_M * Math.pow(2, Math.max(0, Math.min(MAX_LEVEL, level)));
}

// Nearest pyramid level for a desired cell size in metres (used to snap the
// coarse full-extent base layer onto the ladder).
export function levelForCellMeters(cellMeters) {
    if (!(cellMeters > CELL_BASE_M)) return 0;
    return Math.max(0, Math.min(MAX_LEVEL, Math.round(Math.log2(cellMeters / CELL_BASE_M))));
}

// Pick the detail level for a view from its metres-per-pixel. Aims for cells
// ~TARGET_CELL_PX on screen. With a prevLevel, keeps it unless the ideal is
// clearly (>HYSTERESIS levels) away — so a small zoom wobble near a boundary
// doesn't flip the level (and re-cluster) repeatedly. A decisive zoom jumps
// straight to the new level.
export function pickDetailLevel(metersPerPixel, prevLevel = null) {
    const clamp = l => Math.max(0, Math.min(MAX_LEVEL, l));
    if (!(metersPerPixel > 0)) return prevLevel == null ? 0 : clamp(prevLevel);
    const ideal = Math.log2((metersPerPixel * TARGET_CELL_PX) / CELL_BASE_M);
    if (prevLevel == null) return clamp(Math.round(ideal));
    if (Math.abs(ideal - prevLevel) <= HYSTERESIS) return clamp(prevLevel);
    return clamp(Math.round(ideal));
}

// Global-aligned integer cell indices for a point at a given cell size. floor()
// (not round) so level L+1 cells exactly contain level L cells (nesting). lon
// uses cos(lat) so cells are ~square in metres.
export function cellIndices(cellMeters, lat, lon) {
    const latCell = cellMeters / 111320;
    const lonCell = cellMeters / (111320 * Math.cos(lat * Math.PI / 180) || 1);
    return { gx: Math.floor(lon / lonCell), gy: Math.floor(lat / latCell) };
}

// Aggregation key: a repeater's cell at this size. The SAME point always yields
// the SAME key regardless of the query region, so panning never shifts a point
// between cells.
export function cellKey(cellMeters, rawId, lat, lon) {
    const { gx, gy } = cellIndices(cellMeters, lat, lon);
    return rawId + '|' + gx + '|' + gy;
}

// Merge already-aggregated cells up to a COARSER size. Each input is a cell
// representative { rawId, lat, lon, snr, rssi, time, count }. Because the levels
// nest, coarsening the finest cells yields EXACTLY the same aggregate as querying
// the coarser level directly: counts sum, and the representative (most-recent
// observation) is preserved. This lets the map do a single fine query and then
// step up only if the dot count exceeds its budget — so clustering is driven by
// DENSITY (how many dots are actually in view), not by the zoom level. A sparse
// view stays at the finest level (every point shown) no matter how you zoom.
export function coarsenCells(cells, cellMeters) {
    const m = new Map();
    for (const r of cells) {
        const { gx, gy } = cellIndices(cellMeters, r.lat, r.lon);
        const k = r.rawId + '|' + gx + '|' + gy;
        const g = m.get(k);
        if (!g) {
            m.set(k, { rawId: r.rawId, lat: r.lat, lon: r.lon, snr: r.snr, rssi: r.rssi, time: r.time, count: r.count });
        } else {
            g.count += r.count;
            if (r.time >= g.time) { g.lat = r.lat; g.lon = r.lon; g.snr = r.snr; g.rssi = r.rssi; g.time = r.time; }
        }
    }
    return [...m.values()];
}
