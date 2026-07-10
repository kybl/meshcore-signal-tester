// Unit tests for TimeWindows (time-windows.js): select parsing, the display
// cutoff, the frozen chart clock, the Display ≤ Auto-remove invariant, and the
// RAM-window derivation. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeWindows } from '../time-windows.js';

const MIN = 60_000;

test('msFromSelect: seconds → ms; all/Infinity → unbounded', () => {
    assert.equal(TimeWindows.msFromSelect('900'), 900_000);
    assert.equal(TimeWindows.msFromSelect('30'), 30_000);
    assert.equal(TimeWindows.msFromSelect('all'), Infinity);
    assert.equal(TimeWindows.msFromSelect('Infinity'), Infinity);
});

test('displayCutoff: finite window → now - span; unbounded → 0 (falsy)', () => {
    const w = new TimeWindows({ displayMs: 15 * MIN });
    const cutoff = w.displayCutoff();
    assert.ok(Math.abs(cutoff - (Date.now() - 15 * MIN)) < 100);
    w.displayMs = Infinity;
    assert.equal(w.displayCutoff(), 0);
});

test('now(): frozen clock wins; null means live', () => {
    const w = new TimeWindows({ frozenAt: 12345 });
    assert.equal(w.now(), 12345);
    w.frozenAt = null;
    assert.ok(Math.abs(w.now() - Date.now()) < 100);
});

test('allowsDisplay: finite Display must not exceed finite retention', () => {
    const w = new TimeWindows({ retentionMs: 15 * MIN });
    assert.ok(w.allowsDisplay(15 * MIN));
    assert.ok(w.allowsDisplay(5 * MIN));
    assert.ok(!w.allowsDisplay(60 * MIN));
    // "All" stays selectable under a finite retention — it means "same as
    // Auto-remove" (matches the pre-existing UI behaviour).
    assert.ok(w.allowsDisplay(Infinity));
    w.retentionMs = Infinity;
    assert.ok(w.allowsDisplay(12 * 60 * MIN), 'everything allowed under unbounded retention');
});

test('ramWindowMs pre-ready: retention, else display, else unbounded', () => {
    assert.equal(new TimeWindows({ retentionMs: 10 * MIN, displayMs: 5 * MIN }).ramWindowMs(false), 10 * MIN);
    assert.equal(new TimeWindows({ retentionMs: Infinity, displayMs: 5 * MIN }).ramWindowMs(false), 5 * MIN);
    assert.equal(new TimeWindows({ retentionMs: Infinity, displayMs: Infinity }).ramWindowMs(false), Infinity);
});

test('ramWindowMs ready: max(display, budget) capped by retention', () => {
    const budget = 60 * MIN;
    // small display → budget wins
    assert.equal(new TimeWindows({ retentionMs: Infinity, displayMs: 5 * MIN, renderBudgetMs: budget }).ramWindowMs(true), budget);
    // wide display → display wins
    assert.equal(new TimeWindows({ retentionMs: Infinity, displayMs: 3 * 60 * MIN, renderBudgetMs: budget }).ramWindowMs(true), 3 * 60 * MIN);
    // retention caps everything
    assert.equal(new TimeWindows({ retentionMs: 10 * MIN, displayMs: 5 * MIN, renderBudgetMs: budget }).ramWindowMs(true), 10 * MIN);
    // display "All" → 0 for the max() → budget (capped by retention)
    assert.equal(new TimeWindows({ retentionMs: Infinity, displayMs: Infinity, renderBudgetMs: budget }).ramWindowMs(true), budget);
});
