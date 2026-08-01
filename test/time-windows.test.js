// Unit tests for TimeWindows (time-windows.js): select parsing, the display
// cutoff, the frozen chart clock, the Display ≤ Auto-remove invariant, and the
// RAM-window derivation. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeWindows, formatWhen, formatWhenMs, msUntilNextMidnight } from '../time-windows.js';

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

// --- formatWhen / formatWhenMs / msUntilNextMidnight ------------------------

test('formatWhen: time only on the same day, dd/mm prefix on any other', () => {
    const now = new Date(2026, 6, 17, 10, 0, 0);           // 17 Jul 2026
    const today = new Date(2026, 6, 17, 14, 23, 5).getTime();
    assert.equal(formatWhen(today, now), '14:23:05');
    const yesterday = new Date(2026, 6, 16, 23, 59, 58).getTime();
    assert.equal(formatWhen(yesterday, now), '16/07 23:59:58');
    // Same date in a different month/year is NOT the same day
    const lastMonth = new Date(2026, 5, 17, 14, 23, 5).getTime();
    assert.equal(formatWhen(lastMonth, now), '17/06 14:23:05');
    const lastYear = new Date(2025, 6, 17, 14, 23, 5).getTime();
    assert.equal(formatWhen(lastYear, now), '17/07 14:23:05');
});

test('formatWhen: midnight boundary flips the same instant from dated to bare', () => {
    const ts = new Date(2026, 6, 16, 23, 59, 58).getTime();
    const beforeMidnight = new Date(2026, 6, 16, 23, 59, 59);
    const afterMidnight  = new Date(2026, 6, 17, 0, 0, 1);
    assert.equal(formatWhen(ts, beforeMidnight), '23:59:58');
    assert.equal(formatWhen(ts, afterMidnight), '16/07 23:59:58');
});

test('formatWhenMs: keeps milliseconds, gains the same date prefix', () => {
    const now = new Date(2026, 6, 17, 10, 0, 0);
    const today = new Date(2026, 6, 17, 9, 5, 7, 42).getTime();
    assert.equal(formatWhenMs(today, now), '09:05:07.042');
    const other = new Date(2026, 6, 2, 9, 5, 7, 420).getTime();
    assert.equal(formatWhenMs(other, now), '02/07 09:05:07.420');
});

test('msUntilNextMidnight: counts down to local 00:00', () => {
    assert.equal(msUntilNextMidnight(new Date(2026, 6, 17, 23, 59, 0)), 60_000);
    assert.equal(msUntilNextMidnight(new Date(2026, 6, 17, 0, 0, 0)), 24 * 3600_000);
    // month rollover
    assert.equal(msUntilNextMidnight(new Date(2026, 6, 31, 23, 0, 0)), 3600_000);
});
