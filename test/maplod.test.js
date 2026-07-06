// Unit tests for the 3D-map LOD pyramid (maplod.js): discrete level ladder,
// hysteresis, and global-aligned nesting cells. These pin the properties that
// keep the map clustering visually stable while the camera moves. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cellMetersForLevel, levelForCellMeters, pickDetailLevel, cellIndices, cellKey, snapBboxToCells,
} from '../maplod.js';

// ---- the ladder -----------------------------------------------------------
// (Exact rung values track the CELL_BASE_M constant in maplod.js.)

test('cellMetersForLevel: coarse factor-2 ladder from 2 m', () => {
    assert.equal(cellMetersForLevel(0), 2);
    assert.equal(cellMetersForLevel(1), 4);
    assert.equal(cellMetersForLevel(2), 8);
    assert.equal(cellMetersForLevel(4), 32);
    // each level is exactly 2× the one below
    for (let l = 0; l < 12; l++) {
        assert.equal(cellMetersForLevel(l + 1) / cellMetersForLevel(l), 2);
    }
});

test('levelForCellMeters inverts cellMetersForLevel on rungs', () => {
    for (let l = 0; l <= 20; l++) {
        assert.equal(levelForCellMeters(cellMetersForLevel(l)), l);
    }
    assert.equal(levelForCellMeters(1), 0);       // below finest → level 0
    assert.equal(levelForCellMeters(60), 5);      // 64 m rung is nearest to 60
});

// ---- level selection + hysteresis ----------------------------------------

test('pickDetailLevel: finer view (smaller m/px) → not-coarser level (monotone)', () => {
    let prevLevel = null, prevMpp = Infinity;
    for (const mpp of [50, 20, 8, 3, 1, 0.3, 0.1]) {   // zooming in
        const lvl = pickDetailLevel(mpp, null);
        if (prevLevel != null) assert.ok(lvl <= prevLevel, `zooming in must not coarsen (${mpp})`);
        prevLevel = lvl; prevMpp = mpp;
    }
});

test('pickDetailLevel: without a previous level, rounds to the nearest ideal', () => {
    // ideal cell = mpp * TARGET_CELL_PX(24); level = round(log2(ideal/CELL_BASE_M(2)))
    // mpp=1 → ideal 24 → log2(12)=3.58 → level 4
    assert.equal(pickDetailLevel(1, null), 4);
    // mpp=0.1 → ideal 2.4 → log2(1.2)=0.26 → 0
    assert.equal(pickDetailLevel(0.1, null), 0);
});

test('pickDetailLevel: hysteresis keeps the level within the dead-band', () => {
    // Settle at some level, then jitter m/px slightly around it: the level must
    // not change (no flicker). Pick an mpp whose ideal sits near a level.
    const settled = pickDetailLevel(1.0, null);        // level 4
    // small jitters around 1.0 stay at the settled level
    for (const mpp of [0.9, 1.0, 1.1, 1.15, 0.85]) {
        assert.equal(pickDetailLevel(mpp, settled), settled, `jitter ${mpp} flipped the level`);
    }
});

test('pickDetailLevel: a decisive zoom past the dead-band does switch (and can jump)', () => {
    const start = pickDetailLevel(1.0, null);          // level 4
    // zoom out hard → coarser level
    const coarser = pickDetailLevel(16, start);
    assert.ok(coarser > start);
    // zoom in hard → finer level
    const finer = pickDetailLevel(0.1, start);
    assert.ok(finer < start);
});

test('pickDetailLevel: no oscillation — repeatedly re-evaluating a fixed view is stable', () => {
    let lvl = pickDetailLevel(2.3, null);
    for (let i = 0; i < 20; i++) {
        const next = pickDetailLevel(2.3, lvl);
        assert.equal(next, lvl, 'level should converge and stay put');
        lvl = next;
    }
});

// ---- global-aligned nesting cells ----------------------------------------

test('cellKey is independent of any query region (pure in the point)', () => {
    const cell = cellMetersForLevel(3);
    const k1 = cellKey(cell, 'AB', 50.088, 14.42);
    const k2 = cellKey(cell, 'AB', 50.088, 14.42);
    assert.equal(k1, k2);
    // different repeater → different key even at the same spot
    assert.notEqual(cellKey(cell, 'AB', 50.088, 14.42), cellKey(cell, 'CD', 50.088, 14.42));
});

test('two points within one cell share a key; across a boundary they differ', () => {
    const cell = cellMetersForLevel(6);   // 128 m
    // Place both points at the CENTRE of a cell (± a fraction of a cell) so they
    // can't straddle a boundary; then a point several cells away must differ.
    const latCell = cell / 111320;
    const base = 50.0;
    const gy = Math.floor(base / latCell);
    const centreLat = (gy + 0.5) * latCell;     // cell centre
    const a = cellKey(cell, 'X', centreLat, 14.00000);
    const b = cellKey(cell, 'X', centreLat + latCell * 0.2, 14.00001);
    assert.equal(a, b);
    // a point several cells north differs
    const c = cellKey(cell, 'X', centreLat + latCell * 3, 14.00000);
    assert.notEqual(a, c);
});

test('nesting: a level-(L+1) cell is exactly the parent of the level-L cell', () => {
    // gy_{L+1} = floor(gy_L / 2), gx_{L+1} = floor(gx_L / 2) — the quadtree parent.
    const pts = [[50.088, 14.42], [-33.9, 151.2], [0.5, -0.12], [60.17, 24.94]];
    for (let L = 0; L <= 18; L++) {
        for (const [lat, lon] of pts) {
            const lo = cellIndices(cellMetersForLevel(L), lat, lon);
            const hi = cellIndices(cellMetersForLevel(L + 1), lat, lon);
            assert.equal(hi.gx, Math.floor(lo.gx / 2), `gx nest @L${L}`);
            assert.equal(hi.gy, Math.floor(lo.gy / 2), `gy nest @L${L}`);
        }
    }
});

test('stability: the same geographic point maps to the same cell no matter the pan', () => {
    // Simulate panning: the cell key for a fixed point never changes with the
    // (irrelevant) surrounding view — the property that stops mid-view churn.
    const cell = cellMetersForLevel(5);
    const key = cellKey(cell, 'R', 50.05, 14.30);
    for (let i = 0; i < 100; i++) {
        assert.equal(cellKey(cell, 'R', 50.05, 14.30), key);
    }
});

// ---- bbox snapping (no partial edge cells) --------------------------------

test('snapBboxToCells: expands outward and lands on whole cell boundaries', () => {
    const cell = cellMetersForLevel(6);   // 128 m
    const bbox = { minLat: 50.010, maxLat: 50.030, minLon: 14.400, maxLon: 14.440 };
    const snapped = snapBboxToCells(bbox, cell);
    // strictly contains the input (expanded outward, never inward)
    assert.ok(snapped.minLat <= bbox.minLat, 'minLat expands down');
    assert.ok(snapped.maxLat >= bbox.maxLat, 'maxLat expands up');
    assert.ok(snapped.minLon <= bbox.minLon, 'minLon expands down');
    assert.ok(snapped.maxLon >= bbox.maxLon, 'maxLon expands up');
    // corners land exactly on cell edges: their indices match the corner point's cell
    const lo = cellIndices(cell, snapped.minLat + 1e-9, snapped.minLon + 1e-9);
    const loEdge = cellIndices(cell, snapped.minLat, snapped.minLon);
    assert.equal(lo.gx, loEdge.gx);
    assert.equal(lo.gy, loEdge.gy);
});

test('snapBboxToCells: every point in the original bbox stays inside the snapped bbox', () => {
    const cell = cellMetersForLevel(4);   // 32 m
    const bbox = { minLat: -33.905, maxLat: -33.880, minLon: 151.200, maxLon: 151.235 };
    const s = snapBboxToCells(bbox, cell);
    for (const lat of [bbox.minLat, (bbox.minLat + bbox.maxLat) / 2, bbox.maxLat]) {
        for (const lon of [bbox.minLon, (bbox.minLon + bbox.maxLon) / 2, bbox.maxLon]) {
            assert.ok(lat >= s.minLat && lat <= s.maxLat, `lat ${lat} inside`);
            assert.ok(lon >= s.minLon && lon <= s.maxLon, `lon ${lon} inside`);
        }
    }
});

test('snapBboxToCells: the snapped span is a whole number of cells', () => {
    // The clean grid-alignment property: after snapping, both the lat and lon
    // extents are exact integer multiples of the cell size. (Strict idempotence
    // doesn't hold near a boundary — snapping shifts the mid-latitude, which
    // nudges the lon cell width — so we assert the invariant that actually holds.)
    const cell = cellMetersForLevel(6);
    const bbox = { minLat: 50.010, maxLat: 50.030, minLon: 14.400, maxLon: 14.440 };
    const s = snapBboxToCells(bbox, cell);
    // snapBboxToCells derives lonCell from the INPUT bbox mid-latitude.
    const latCell = cell / 111320;
    const lonCell = cell / (111320 * Math.cos(((bbox.minLat + bbox.maxLat) / 2) * Math.PI / 180));
    const latSpanCells = (s.maxLat - s.minLat) / latCell;
    const lonSpanCells = (s.maxLon - s.minLon) / lonCell;
    assert.ok(Math.abs(latSpanCells - Math.round(latSpanCells)) < 1e-6, `lat span ${latSpanCells}`);
    assert.ok(Math.abs(lonSpanCells - Math.round(lonSpanCells)) < 1e-6, `lon span ${lonSpanCells}`);
});
