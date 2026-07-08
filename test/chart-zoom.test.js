// Unit tests for the live-follow zoom-window decision (chart-zoom.js): the two
// edge cases where an active 2D-chart zoom should track time, plus the cases
// where it must stay put. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceZoomWindow } from '../chart-zoom.js';

const MIN = 60_000;

// ---- (1) follow the live/right edge ---------------------------------------

test('followLive: right edge tracks now, span preserved', () => {
    const now = 1_000_000;
    const zoom = { tMin: now - 10 * MIN - 5000, tMax: now - 5000 };   // 5 s behind live
    const next = advanceZoomWindow(zoom, now, { displayLifetime: Infinity }, true);
    assert.ok(next, 'should move');
    assert.equal(next.tMax, now);
    assert.equal(next.tMax - next.tMin, zoom.tMax - zoom.tMin);       // span kept
});

test('followLive: already exactly at now → no change (null)', () => {
    const now = 2_000_000;
    const zoom = { tMin: now - 10 * MIN, tMax: now };
    assert.equal(advanceZoomWindow(zoom, now, { displayLifetime: Infinity }, true), null);
});

test('followLive keeps following across successive ticks', () => {
    let zoom = { tMin: 0, tMax: 10 * MIN };
    for (const now of [10 * MIN + 2000, 10 * MIN + 4000, 10 * MIN + 6000]) {
        const next = advanceZoomWindow(zoom, now, { displayLifetime: Infinity }, true);
        assert.equal(next.tMax, now);
        assert.equal(next.tMax - next.tMin, 10 * MIN);
        zoom = next;
    }
});

// ---- not following, no pruning → stays put --------------------------------

test('not following, infinite Display → window never moves', () => {
    const now = 5_000_000;
    const zoom = { tMin: now - 30 * MIN, tMax: now - 20 * MIN };      // parked in the middle
    assert.equal(advanceZoomWindow(zoom, now, { displayLifetime: Infinity }, false), null);
});

// ---- (2) ride the prune edge ----------------------------------------------

test('prune ride: left edge past the Display cutoff → pushed to the cutoff, span kept', () => {
    const now = 10_000_000;
    const displayLifetime = 15 * MIN;
    const cutoff = now - displayLifetime;
    // Window sits entirely older than the cutoff (its data has been pruned away).
    const zoom = { tMin: cutoff - 10 * MIN, tMax: cutoff - 5 * MIN };
    const next = advanceZoomWindow(zoom, now, { displayLifetime }, false);
    assert.ok(next, 'should move');
    assert.equal(next.tMin, cutoff);
    assert.equal(next.tMax - next.tMin, zoom.tMax - zoom.tMin);
});

test('prune ride keeps the left edge pinned to the advancing cutoff', () => {
    const displayLifetime = 15 * MIN;
    let zoom = { tMin: 0, tMax: 5 * MIN };
    for (const now of [30 * MIN, 32 * MIN, 34 * MIN]) {
        const next = advanceZoomWindow(zoom, now, { displayLifetime }, false);
        assert.equal(next.tMin, now - displayLifetime, `cutoff-pinned @${now}`);
        assert.equal(next.tMax - next.tMin, 5 * MIN);
        zoom = next;
    }
});

test('prune ride uses hashLifetime when Display is "All" (infinite)', () => {
    const now = 10_000_000;
    const hashLifetime = 20 * MIN;
    const cutoff = now - hashLifetime;
    const zoom = { tMin: cutoff - 8 * MIN, tMax: cutoff - 3 * MIN };
    const next = advanceZoomWindow(zoom, now, { displayLifetime: Infinity, hashLifetime }, false);
    assert.equal(next.tMin, cutoff);
});

test('prune ride: window still inside the visible window → no move', () => {
    const now = 10_000_000;
    const displayLifetime = 15 * MIN;
    // left edge newer than the cutoff → still shows data, must not be dragged
    const zoom = { tMin: now - 10 * MIN, tMax: now - 5 * MIN };
    assert.equal(advanceZoomWindow(zoom, now, { displayLifetime }, false), null);
});

// ---- precedence + guards ---------------------------------------------------

test('followLive wins over the prune-ride branch', () => {
    const now = 10_000_000;
    const displayLifetime = 5 * MIN;
    // A wide window whose left edge is well past the cutoff, but pinned live:
    // it must follow now (right edge), not ride the cutoff.
    const zoom = { tMin: now - 20 * MIN, tMax: now - 1000 };
    const next = advanceZoomWindow(zoom, now, { displayLifetime }, true);
    assert.equal(next.tMax, now);
    assert.equal(next.tMax - next.tMin, zoom.tMax - zoom.tMin);   // span preserved
});

test('no window → null', () => {
    assert.equal(advanceZoomWindow(null, 123, { displayLifetime: Infinity }, true), null);
});
