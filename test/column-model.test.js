// Unit tests for ColumnModel (column-model.js) — the stateful half of the
// column system: the lifecycle (resolve/add/rename/split with hook fan-out),
// the session stats (ingest, recompute, disk widening) and the display sort.
// The pure resolution semantics are pinned separately in column-key.test.js.
// `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColumnModel } from '../column-model.js';

function make() {
    const events = [];
    const m = new ColumnModel({
        displayId: id => id,
        onRename: (o, n) => events.push(['rename', o, n]),
        onSplit:  (e, c, p) => events.push(['split', e, c, p]),
    });
    return { m, events };
}

// ---- lifecycle ---------------------------------------------------------------

test('resolve: a new raw id adds its column; a longer id promotes (rename hook)', () => {
    const { m, events } = make();
    assert.equal(m.resolve('12'), '12');
    assert.deepEqual(m.list, ['12']);
    // longer id for the same node → column promoted, hook told to retag views
    assert.equal(m.resolve('1234'), '1234');
    assert.deepEqual(m.list, ['1234']);
    assert.deepEqual(events, [['rename', '12', '1234']]);
});

test('resolve: a sibling id splits a column that absorbed short-precision entries', () => {
    const { m, events } = make();
    // '12' packets absorbed into a column later promoted to '1234'
    // (minPrecision 1 records that short evidence lives inside it).
    m.resolve('12');   m.noteObservation('12', '12', 1, 1, -90);
    m.resolve('1234'); m.noteObservation('1234', '1234', 2, 1, -90);
    // A distinct sibling arrives: the short entries inside '1234' are now
    // ambiguous → collision column + onSplit for the view retagging.
    const key = m.resolve('1289');
    assert.equal(key, '1289');
    assert.ok(m.has('1234') && m.has('1289'), 'specific columns exist');
    const split = events.find(e => e[0] === 'split');
    assert.ok(split, 'split hook fired');
    assert.equal(split[1], '1234', 'the absorbing column is split');
    assert.ok(m.has(split[2]), 'the collision column was registered');
    assert.equal(split[3], 2, 'existing precision (bytes) passed for entry filtering');
});

test('rename merges stats into an existing target (totals add, newer lasts win)', () => {
    const { m } = make();
    m.add('AA'); m.add('BB');
    m.noteObservation('AA', 'AA', 100, 5, -80);
    m.noteObservation('BB', 'BB', 200, 1, -100);
    m.rename('AA', 'BB');
    assert.deepEqual(m.list, ['BB'], 'merged, not duplicated');
    const s = m.stats('BB');
    assert.equal(s.count, 2);
    assert.equal(s.lastSeen, 200);
    assert.equal(s.lastSnr, 1, 'newer side wins the last values');
    assert.equal(s.maxSnr, 5, 'maxes merge');
    assert.equal(s.maxRssi, -80);
    assert.equal(m.stats('AA'), undefined);
});

test('remove drops column, stats and colour seed; clear resets everything', () => {
    const { m } = make();
    m.add('AA'); m.noteObservation('AA', 'AA', 1, 1, -90); m.colorSeed('AA');
    m.remove('AA');
    assert.equal(m.count, 0);
    assert.equal(m.stats('AA'), undefined);
    m.add('BB');
    m.clear();
    assert.equal(m.count, 0);
});

// ---- stats -------------------------------------------------------------------

test('noteObservation accumulates like live ingest (nulls keep previous values)', () => {
    const { m } = make();
    m.add('AA');
    m.noteObservation('AA', 'AA', 100, 5, -80);
    m.noteObservation('AA', 'AA', 200, null, null);   // packet without SNR/RSSI
    const s = m.stats('AA');
    assert.equal(s.count, 2);
    assert.equal(s.lastSeen, 200);
    assert.equal(s.lastSnr, 5, 'null does not clobber the last reading');
    assert.equal(s.maxRssi, -80);
});

test('recomputeFromPoints rebuilds stats and removes empty columns', () => {
    const { m } = make();
    m.add('AA'); m.add('GONE');
    m.noteObservation('GONE', 'GONE', 1, 1, -90);
    const pts = [
        { col: 'AA', rawId: 'AA', time: 10, snr: 2, rssi: -70 },
        { col: 'AA', rawId: 'AA', time: 20, snr: 8, rssi: -95 },
    ];
    m.recomputeFromPoints('AA', pts);
    m.recomputeFromPoints('GONE', pts);   // no points left → dissolve
    assert.equal(m.stats('AA').count, 2);
    assert.equal(m.stats('AA').maxSnr, 8);
    assert.equal(m.stats('AA').lastSnr, 8);
    assert.ok(!m.has('GONE'), 'zero-point column removed');
});

test('mergeDiskAggregates widens live totals and re-adds disk-only columns', () => {
    const { m } = make();
    m.add('LIVE');
    m.noteObservation('LIVE', 'LIVE', 100, 5, -80);
    const agg = new Map([
        ['LIVE', { count: 50, lastSeen: 90, maxSnr: 9, maxRssi: -60, lastSnr: 1, lastRssi: -99, minPrecision: 2 }],
        ['DISK', { count: 7,  lastSeen: 80, maxSnr: 3, maxRssi: -70, lastSnr: 3, lastRssi: -70, minPrecision: Infinity }],
    ]);
    assert.equal(m.mergeDiskAggregates(agg), true);
    const live = m.stats('LIVE');
    assert.equal(live.count, 50, 'total widened from disk');
    assert.equal(live.maxSnr, 9);
    assert.equal(live.lastSnr, 5, 'exact live last value kept');
    assert.equal(live.lastSeen, 100, 'live lastSeen kept');
    assert.ok(m.has('DISK'), 'disk-only column added');
    assert.ok(Number.isFinite(m.stats('DISK').minPrecision), 'minPrecision backfilled');
    assert.equal(m.mergeDiskAggregates(agg), false, 'idempotent → no change reported');
});

// ---- sort + colours -----------------------------------------------------------

test('sort ladder: recent count, page presence, lastRssi, lastSnr, total, name', () => {
    const { m } = make();
    for (const c of ['NAME_B', 'NAME_A', 'TOTAL', 'SNR', 'RSSI', 'PAGE', 'RECENT']) m.add(c);
    m.noteObservation('TOTAL', 'TOTAL', 1, null, null);
    m.noteObservation('TOTAL', 'TOTAL', 2, null, null);
    m.noteObservation('SNR',  'SNR',  1, 5, null);
    m.noteObservation('RSSI', 'RSSI', 1, 5, -60);
    m.sort({
        recentCount: new Map([['RECENT', 3]]),
        pageCounts:  new Map([['PAGE', 2]]),
    });
    assert.deepEqual(m.list, ['RECENT', 'PAGE', 'RSSI', 'SNR', 'TOTAL', 'NAME_A', 'NAME_B']);
});

test('colorSeed is deterministic in the display id and survives re-ask', () => {
    const { m } = make();
    const s1 = m.colorSeed('AB12');
    assert.equal(m.colorSeed('AB12'), s1, 'memoised');
    m.remove('AB12');
    assert.equal(m.colorSeed('AB12'), s1, 'recomputed identically after eviction');
    assert.notEqual(m.colorSeed('CD34'), s1);
});
