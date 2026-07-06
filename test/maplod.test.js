// Unit tests for the 3D-map LOD pyramid (maplod.js): discrete level ladder,
// hysteresis, and global-aligned nesting cells. These pin the properties that
// keep the map clustering visually stable while the camera moves. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cellMetersForLevel, levelForCellMeters, pickDetailLevel, cellIndices, cellKey,
} from '../maplod.js';

// ---- the ladder -----------------------------------------------------------

test('cellMetersForLevel: coarse factor-2 ladder from 5 m', () => {
    assert.equal(cellMetersForLevel(0), 5);
    assert.equal(cellMetersForLevel(1), 10);
    assert.equal(cellMetersForLevel(2), 20);
    assert.equal(cellMetersForLevel(4), 80);
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
    assert.equal(levelForCellMeters(60), 4);      // ~80 m rung is nearest to 60
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
    // ideal cell = mpp * 46; level = round(log2(ideal/5))
    // mpp=1 → ideal 46 → log2(9.2)=3.2 → level 3
    assert.equal(pickDetailLevel(1, null), 3);
    // mpp=0.1 → ideal 4.6 → below finest → 0
    assert.equal(pickDetailLevel(0.1, null), 0);
});

test('pickDetailLevel: hysteresis keeps the level within the dead-band', () => {
    // Settle at some level, then jitter m/px slightly around it: the level must
    // not change (no flicker). Pick an mpp whose ideal sits near a level.
    const settled = pickDetailLevel(1.0, null);        // level 3
    // small jitters around 1.0 stay at the settled level
    for (const mpp of [0.9, 1.0, 1.1, 1.15, 0.85]) {
        assert.equal(pickDetailLevel(mpp, settled), settled, `jitter ${mpp} flipped the level`);
    }
});

test('pickDetailLevel: a decisive zoom past the dead-band does switch (and can jump)', () => {
    const start = pickDetailLevel(1.0, null);          // level 3
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
    const cell = cellMetersForLevel(2);   // 20 m
    // ~20 m ≈ 0.00018° lat. Two points a few metres apart land in the same cell.
    const a = cellKey(cell, 'X', 50.00000, 14.00000);
    const b = cellKey(cell, 'X', 50.00005, 14.00003);
    assert.equal(a, b);
    // a point a couple of cells away differs
    const c = cellKey(cell, 'X', 50.00100, 14.00100);
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
