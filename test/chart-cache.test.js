// Unit tests for ChartCache (chart-cache.js) — the 2D charts' time-bucket
// cache. Focus: no observation may be lost or double-counted when live points
// arrive while the base is being rebuilt from disk. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChartCache } from '../chart-cache.js';

// A model stub with a write buffer + "disk", mirroring CaptureModel semantics:
// observations are buffered, flush() moves them to disk, bucketObs scans disk.
function stubModel({ scanDelayMs = 0 } = {}) {
    const buf = [], disk = [];
    return {
        ready: true,
        buffer(o) { buf.push(o); },
        async flush() { disk.push(...buf.splice(0)); },
        // A timer flush happening DURING a slow scan (the periodic write-through).
        flushMidScan: false,
        async bucketObs(from, to, n) {
            await new Promise(r => setTimeout(r, scanDelayMs));
            if (this.flushMidScan) disk.push(...buf.splice(0));
            const width = 1000, lo = Math.floor((Date.now() - 60_000) / width) * width;
            const cells = new Map();
            for (const o of disk) {
                if (o.time < from || o.time > to) continue;
                const bIdx = Math.floor((o.time - lo) / width);
                const k = o.rawId + '|' + bIdx;
                const b = cells.get(k) ?? { rawId: o.rawId, bIdx, time: lo + bIdx * width, count: 0,
                    snrMin: null, snrMax: null, snrSum: 0, snrN: 0, rssiMin: null, rssiMax: null,
                    rssiSum: 0, rssiN: 0, lastSnrT: -Infinity, lastSnr: null, lastRssiT: -Infinity, lastRssi: null };
                b.count++;
                cells.set(k, b);
            }
            return { buckets: [...cells.values()], width, lo };
        },
        async eachSent() {},
    };
}

function makeCache(model) {
    return new ChartCache(model, {
        bucketCount: 1500,
        resolveCol: id => id, idPrecision: () => 1,
        displayCutoff: () => 0, displayLifetime: () => Infinity,
        frozenAt: () => null, zoomWindow: () => null,
        seedColumn: () => {}, onDerived: () => {}, afterBaseBuild: () => {},
    });
}

const total = cache => [...cache.aggregateRepeaterStats().values()].reduce((s, a) => s + a.count, 0);

// Ingest exactly like the app: the observation goes to the model buffer AND to
// the chart cache in the same synchronous step, with the same timestamp.
function ingest(model, cache, time) {
    model.buffer({ time, rawId: '5E' });
    cache.upsert(time, 1, -90, '5E');
}

for (const flushMidScan of [false, true]) {
    test(`points arriving during a rebuild are neither lost nor double-counted (timer flush mid-scan: ${flushMidScan})`, async () => {
        const model = stubModel({ scanDelayMs: 50 });
        model.flushMidScan = flushMidScan;
        const cache = makeCache(model);
        for (let i = 0; i < 5; i++) ingest(model, cache, Date.now() - 10_000 + i);   // before: base missing
        const build = cache.rebuildBase();
        // Live points keep arriving while the scan is "slow".
        for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 5)); ingest(model, cache, Date.now()); }
        await build;
        assert.equal(total(cache), 11);
        // After the build, live points fold straight in.
        ingest(model, cache, Date.now() + 1);
        assert.equal(total(cache), 12);
    });
}

test('two overlapping rebuilds still end with every point exactly once', async () => {
    const model = stubModel({ scanDelayMs: 30 });
    const cache = makeCache(model);
    ingest(model, cache, Date.now() - 5000);
    const a = cache.rebuildBase();
    await new Promise(r => setTimeout(r, 10));
    ingest(model, cache, Date.now());
    const b = cache.rebuildBase();
    await new Promise(r => setTimeout(r, 10));
    ingest(model, cache, Date.now());
    await Promise.all([a, b]);
    assert.equal(total(cache), 3);
});
