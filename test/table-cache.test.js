// Unit tests for TableCache (table-cache.js) — the Received Packets disk-page
// cache: page assembly, the RAM∪disk union reads, the live-maintained pager
// counts and the narrow index. Model and app deps are stubs, so the previously
// untestable table assembly is pinned here. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TableCache } from '../table-cache.js';

// hashes: [{hash, firstSeen, type, meta}] newest-first (like pageHashes);
// obs: Map hash → [{rawId, time, snr, rssi, ...}]; recent: Map hash → row entry.
function stubModel({ hashes = [], obs = new Map(), recent = new Map(), ready = true } = {}) {
    return {
        ready,
        flush: async () => {},
        countHashes: async () => hashes.length,
        pageHashes: async (offset, limit) => hashes.slice(offset, offset + limit),
        getHashes: async hs => hs.map(h => hashes.find(x => x.hash === h)).filter(Boolean),
        obsForHash: async h => obs.get(h) ?? [],
        eachObs: async (from, to, cb) => {
            const all = [...obs.values()].flat().sort((a, b) => a.time - b.time);
            for (const o of all) if (o.time >= from && o.time <= to) cb(o);
        },
        eachHash: async (from, cb) => {
            const list = hashes.filter(h => !Number.isFinite(from) || h.firstSeen >= from)
                .sort((a, b) => a.firstSeen - b.firstSeen);
            for (const h of list) if (cb(h) === false) break;
        },
        recentEntries: () => recent.entries(),
        recentGet: h => recent.get(h),
        recentHas: h => recent.has(h),
    };
}

// Mutable app-dep state the deps close over (selection/filter, Display window).
function makeDeps() {
    const state = { narrow: null, narrowKey: '', cutoff: 0, msgFilter: '' };
    const deps = {
        resolveCol:    id => id,
        narrowFn:      () => state.narrow,
        narrowKey:     () => state.narrowKey,
        displayCutoff: () => state.cutoff,
        msgFilter:     () => state.msgFilter,
        // Test-side mirror of the app's _rowMatchesFilter: type, repeater raw
        // ids and raw hex — enough to exercise the index paths.
        rowMatches:    (row, f) => (row.type ?? '').toLowerCase().includes(f)
            || [...row.repeaters.values()].some(r => (r.rawId ?? '').toLowerCase().includes(f))
            || (row.rawHex ?? '').toLowerCase().includes(f),
    };
    return { state, deps };
}

function rowEntry(firstSeen, cols = ['A']) {
    return { repeaters: new Map(cols.map(c => [c, { rawId: c, time: firstSeen }])),
             firstSeen, lastSeen: firstSeen, _stub: false };
}

// ---- pager counts kept live at ingest ---------------------------------------

test('noteIngest: counts new hashes and recomputes the page count', () => {
    const { deps } = makeDeps();
    const t = new TableCache(stubModel(), { pageSize: 2, ...deps });
    t.noteIngest('h1', 'A', true);
    t.noteIngest('h1', 'A', false);   // same hash again — no count bump
    t.noteIngest('h2', 'B', true);
    t.noteIngest('h3', 'B', true);
    assert.equal(t.hashCount, 3);
    assert.equal(t.pageCount, 2);     // ceil(3 / 2)
});

test('dropHashes: decrements, clamps, and reports a page falling off the end', () => {
    const { deps } = makeDeps();
    const t = new TableCache(stubModel(), { pageSize: 2, ...deps });
    for (let i = 0; i < 6; i++) t.noteIngest('h' + i, 'A', true);
    assert.equal(t.pageCount, 3);
    assert.equal(t.dropHashes(2), false);   // 4 left → 2 pages, page 0 still valid
    assert.equal(t.hashCount, 4);
    assert.equal(t.dropHashes(100), false); // clamps at 0, page 0 always valid
    assert.equal(t.hashCount, 0);
    assert.equal(t.pageCount, 1);
});

test('narrowKeyChanged fires once per key change', () => {
    const { state, deps } = makeDeps();
    const t = new TableCache(stubModel(), { pageSize: 10, ...deps });
    assert.equal(t.narrowKeyChanged(), false);       // '' initially applied
    state.narrowKey = 's:AB';
    assert.equal(t.narrowKeyChanged(), true);
    assert.equal(t.narrowKeyChanged(), false);       // recorded
    state.narrowKey = '';
    assert.equal(t.narrowKeyChanged(), true);
});

// ---- union reads -------------------------------------------------------------

test('rowData/hasRow: page snapshot first, recent window as fallback', async () => {
    const hashes = [{ hash: 'disk1', firstSeen: 100 }];
    const obs = new Map([['disk1', [{ rawId: 'A', time: 100, rssi: -80 }]]]);
    const recent = new Map([['live1', rowEntry(200)]]);
    const model = stubModel({ hashes, obs, recent });
    const { deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 10, ...deps });
    await t.loadPage(0, true);
    assert.ok(t.rowData('disk1'), 'snapshot row found');
    assert.equal(t.rowData('live1').firstSeen, 200, 'falls back to the recent window');
    assert.ok(t.hasRow('disk1') && t.hasRow('live1'));
    assert.equal(t.rowData('nope'), undefined);
});

// ---- visibleRows: snapshot ∪ page-0 tail --------------------------------------

test('visibleRows merges the page-0 tail, windows, sorts desc and caps', async () => {
    const hashes = [{ hash: 'old', firstSeen: 100 }];
    const obs = new Map([['old', [{ rawId: 'A', time: 100 }]]]);
    const model = stubModel({ hashes, obs, recent: new Map() });
    const { state, deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 3, ...deps });
    await t.loadPage(0, true);
    // live tail: two packets newer than the snapshot boundary, one stale duplicate-covered
    const now = Date.now();
    model.recentEntries = () => new Map([
        ['t1', rowEntry(now + 1)],
        ['t2', rowEntry(now + 2)],
    ]).entries();
    // make tail entries "newer than cacheAt"
    for (const [, d] of model.recentEntries()) d.lastSeen = now + 10;
    let rows = t.visibleRows();
    assert.deepEqual(rows.map(([h]) => h), ['t2', 't1', 'old'], 'newest first, tail merged');
    // Display cutoff hides the old snapshot row
    state.cutoff = now;
    rows = t.visibleRows();
    assert.deepEqual(rows.map(([h]) => h), ['t2', 't1'], 'cutoff applies to the snapshot too');
});

test('visibleRows: narrowed tail skips non-matching rows; cap applies when ready', async () => {
    const model = stubModel({ hashes: [], obs: new Map() });
    const { state, deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 2, ...deps });
    await t.loadPage(0, true);
    const now = Date.now();
    const mk = (cols, fs) => { const e = rowEntry(fs, cols); e.lastSeen = now + 10; return e; };
    model.recentEntries = () => new Map([
        ['a', mk(['A'], now + 1)],
        ['b', mk(['B'], now + 2)],
        ['c', mk(['A'], now + 3)],
    ]).entries();
    state.narrow = c => c === 'A';
    let rows = t.visibleRows();
    assert.deepEqual(rows.map(([h]) => h), ['c', 'a'], 'tail respects the narrowing');
    state.narrow = null;
    rows = t.visibleRows();
    assert.equal(rows.length, 2, 'page-0 rows capped at pageSize when the store is ready');
    assert.deepEqual(rows.map(([h]) => h), ['c', 'b'], 'cap keeps the newest');
});

// ---- page assembly from disk ---------------------------------------------------

test('loadPage assembles rows: strongest RSSI per column, firstSeen/lastSeen, page-0 counts', async () => {
    const hashes = [{ hash: 'h1', firstSeen: 50, type: 'AD' }];
    const obs = new Map([['h1', [
        { rawId: 'A', time: 60, rssi: -90, snr: 1 },
        { rawId: 'A', time: 40, rssi: -70, snr: 2 },   // stronger → representative
        { rawId: 'B', time: 55, rssi: null, snr: 3 },
    ]]]);
    const model = stubModel({ hashes, obs });
    const { deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 10, ...deps });
    await t.loadPage(0, true);
    const row = t.rowData('h1');
    assert.equal(row.repeaters.get('A').rssi, -70, 'strongest-RSSI observation wins');
    assert.equal(row.firstSeen, 40);
    assert.equal(row.lastSeen, 60);
    assert.equal(row.type, 'AD');
    assert.equal(t.firstPageColCounts.get('A'), 1);
    assert.equal(t.firstPageColCounts.get('B'), 1);
    assert.ok(t.cacheAt > 0);
    assert.equal(t.hashCount, 1);
});

test('loadPage clamps the requested page into range', async () => {
    const hashes = Array.from({ length: 5 }, (_, i) => ({ hash: 'h' + i, firstSeen: 100 - i }));
    const obs = new Map(hashes.map(h => [h.hash, [{ rawId: 'A', time: h.firstSeen }]]));
    const model = stubModel({ hashes, obs });
    const { deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 2, ...deps });
    await t.loadPage(99, true);
    assert.equal(t.pageCount, 3);
    assert.equal(t.page, 2, 'clamped to the last page');
});

// ---- narrow index ---------------------------------------------------------------

test('pageOfHash builds the narrow index (newest-first) and locates the page', async () => {
    // Hashes h0..h4 heard by A at times 10,20,30,40,50 → narrow index [h4..h0].
    const hashes = Array.from({ length: 5 }, (_, i) => ({ hash: 'h' + i, firstSeen: (i + 1) * 10 }));
    const obs = new Map(hashes.map((h, i) => [h.hash, [{ hash: h.hash, rawId: 'A', time: (i + 1) * 10 }]]));
    // eachObs needs hash on the obs records:
    for (const [h, list] of obs) for (const o of list) o.hash = h;
    const model = stubModel({ hashes, obs });
    const { state, deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 2, ...deps });
    state.narrow = c => c === 'A';
    state.narrowKey = 's:A';
    assert.equal(await t.pageOfHash('h4'), 0, 'newest hash on page 0');
    assert.equal(await t.pageOfHash('h2'), 1);
    assert.equal(await t.pageOfHash('h0'), 2);
    assert.equal(await t.pageOfHash('unknown'), 0, 'unknown hash falls back to page 0');
    await t.loadPage(1, false);   // narrowed load uses the index slice
    assert.ok(t.narrowed);
    assert.ok(t.hasRow('h2'), 'page 1 holds the middle hashes');
});

test('concurrent loadPage calls: the newest call wins wholly', async () => {
    // 6 hashes, pageSize 2 → 3 pages. The first load (page 2) is stalled at its
    // disk read while a second load (page 0) starts and completes; when the
    // stale load finally finishes it must NOT overwrite the newer state.
    const hashes = Array.from({ length: 6 }, (_, i) => ({ hash: 'h' + i, firstSeen: 100 - i }));
    const obs = new Map(hashes.map(h => [h.hash, [{ rawId: 'A', time: h.firstSeen }]]));
    const model = stubModel({ hashes, obs });
    let release;
    const gate = new Promise(r => { release = r; });
    const origPage = model.pageHashes;
    model.pageHashes = async (offset, limit) => {
        if (offset === 4) await gate;          // stall only the page-2 read
        return origPage(offset, limit);
    };
    const { deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 2, ...deps });
    const slow = t.loadPage(2, false);         // stalls at the gated disk read
    await t.loadPage(0, false);                // newer call, completes fully
    assert.equal(t.page, 0);
    assert.ok(t.hasRow('h0'), 'newest rows on page 0');
    release();
    await slow;
    assert.equal(t.page, 0, 'stale slower load must not overwrite the newer page');
    assert.ok(t.hasRow('h0'), 'page-0 snapshot still in place');
    assert.ok(!t.hasRow('h4'), 'page-2 rows were dropped, not committed');
});

// ---- disk-wide message filter -------------------------------------------------

test('message filter pages over the WHOLE history, not just the loaded page', async () => {
    // 6 hashes, pageSize 2 → 3 pages. The two 'Trace' rows are the OLDEST, so
    // unfiltered they sit on page 3 — the filter must still find them.
    const hashes = [
        { hash: 'n1', firstSeen: 600, type: 'Advert' },
        { hash: 'n2', firstSeen: 500, type: 'Advert' },
        { hash: 'n3', firstSeen: 400, type: 'Request' },
        { hash: 'n4', firstSeen: 300, type: 'Request' },
        { hash: 't1', firstSeen: 200, type: 'Direct Trace' },
        { hash: 't2', firstSeen: 100, type: 'Direct Trace' },
    ];
    const obs = new Map(hashes.map(h => [h.hash, [{ rawId: 'A', time: h.firstSeen }]]));
    const model = stubModel({ hashes, obs });
    const { state, deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 2, ...deps });
    await t.loadPage(0, true);
    assert.equal(t.pageCount, 3);
    assert.ok(!t.hasRow('t1'), 'traces are beyond page 1 when unfiltered');

    state.msgFilter = 'trace';
    assert.equal(t.narrowKeyChanged(), true, 'filter change repaginates');
    await t.loadPage(0, true);
    assert.equal(t.textFiltered, true);
    assert.equal(t.filterTotal, 2);
    assert.equal(t.pageCount, 1);
    assert.deepEqual(t.visibleRows().map(([h]) => h), ['t1', 't2'], 'both traces found, newest first');

    state.msgFilter = '';
    assert.equal(t.narrowKeyChanged(), true);
    await t.loadPage(0, true);
    assert.equal(t.textFiltered, false);
    assert.equal(t.filterTotal, null);
    assert.equal(t.pageCount, 3, 'plain paging restored');
});

test('message filter combines with the repeater narrowing (intersection)', async () => {
    const hashes = [
        { hash: 'h1', firstSeen: 400, type: 'Trace' },   // via A
        { hash: 'h2', firstSeen: 300, type: 'Trace' },   // via B
        { hash: 'h3', firstSeen: 200, type: 'Advert' },  // via A
    ];
    const obs = new Map([
        ['h1', [{ hash: 'h1', rawId: 'A', time: 400 }]],
        ['h2', [{ hash: 'h2', rawId: 'B', time: 300 }]],
        ['h3', [{ hash: 'h3', rawId: 'A', time: 200 }]],
    ]);
    const model = stubModel({ hashes, obs });
    const { state, deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 10, ...deps });
    state.narrow = c => c === 'A';
    state.narrowKey = 's:A';
    state.msgFilter = 'trace';
    await t.loadPage(0, true);
    assert.equal(t.filterTotal, 1, 'only h1 is both via A and a Trace');
    assert.ok(t.hasRow('h1'));
    assert.ok(!t.hasRow('h2') && !t.hasRow('h3'));
});

test('a live packet matching the filter joins the index and the pager', async () => {
    const hashes = [{ hash: 'old', firstSeen: 100, type: 'Trace' }];
    const obs = new Map([['old', [{ rawId: 'A', time: 100 }]]]);
    const recent = new Map();
    const model = stubModel({ hashes, obs, recent });
    const { state, deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 1, ...deps });
    state.msgFilter = 'trace';
    await t.loadPage(0, true);
    assert.equal(t.filterTotal, 1);
    // live trace arrives → recent window row, then noteIngest
    recent.set('new', { repeaters: new Map([['A', { rawId: 'A', time: 200 }]]),
                        firstSeen: 200, lastSeen: 200, type: 'Flood Trace', _stub: false });
    t.noteIngest('new', 'A', true);
    assert.equal(t.filterTotal, 2, 'live match counted');
    assert.equal(t.pageCount, 2, 'pager grew');
    assert.equal(await t.pageOfHash('new'), 0, 'newest match pages first');
});

test('clear() resets paging state including the hash count', async () => {
    const hashes = [{ hash: 'h1', firstSeen: 50 }];
    const obs = new Map([['h1', [{ rawId: 'A', time: 50 }]]]);
    const model = stubModel({ hashes, obs });
    const { deps } = makeDeps();
    const t = new TableCache(model, { pageSize: 10, ...deps });
    await t.loadPage(0, true);
    assert.ok(t.hasRow('h1'));
    t.clear();
    assert.ok(!t.hasRow('h1'));
    assert.equal(t.hashCount, 0, 'stale count must not linger after Clear data');
    assert.equal(t.page, 0);
    assert.equal(t.pageCount, 1);
    assert.equal(t.cacheAt, 0);
    assert.equal(t.firstPageColCounts.size, 0);
});
