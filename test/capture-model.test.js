// Unit tests for CaptureModel (capture-model.js) — the owner of the recent RAM
// window, the disk store, and the write-through buffers. The store is injected
// as a stub, so the buffering/flush semantics are testable in Node without
// IndexedDB. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureModel } from '../capture-model.js';

// A stub store recording every call; open() resolves with `openOk`.
function stubStore({ openOk = true } = {}) {
    const calls = [];
    return {
        calls,
        lastError: openOk ? null : new Error('nope'),
        onQuotaExceeded: null,
        open(name)        { calls.push(['open', name]); return Promise.resolve(openOk); },
        putObs(r)         { calls.push(['putObs', r]);         return Promise.resolve(); },
        putHashesMerge(r) { calls.push(['putHashesMerge', r]); return Promise.resolve(); },
        putSent(r)        { calls.push(['putSent', r]);        return Promise.resolve(); },
        setKV(k, v)       { calls.push(['setKV', k, v]);       return Promise.resolve(); },
        getKV(k)          { calls.push(['getKV', k]);          return Promise.resolve(null); },
        countHashes(f)    { calls.push(['countHashes', f]);    return Promise.resolve(42); },
        clearAll()        { calls.push(['clearAll']);          return Promise.resolve(); },
    };
}

const tick = ms => new Promise(r => setTimeout(r, ms));

// ---- recent window ----------------------------------------------------------

test('recent window: set/get/has/delete/size/iteration/clear', () => {
    const m = new CaptureModel({ store: stubStore() });
    m.recentSet('h1', { a: 1 });
    m.recentSet('h2', { a: 2 });
    assert.equal(m.recentSize, 2);
    assert.equal(m.recentGet('h1').a, 1);
    assert.ok(m.recentHas('h2'));
    assert.deepEqual([...m.recentValues()].map(v => v.a).sort(), [1, 2]);
    assert.deepEqual([...m.recentEntries()].map(([k]) => k).sort(), ['h1', 'h2']);
    m.recentDelete('h1');
    assert.ok(!m.recentHas('h1'));
    m.recentClear();
    assert.equal(m.recentSize, 0);
});

test('raw storage is not reachable from outside (private fields)', () => {
    const m = new CaptureModel({ store: stubStore() });
    // No enumerable/own property exposes the Map or the store.
    for (const k of Object.keys(m)) {
        assert.ok(!(m[k] instanceof Map), `own key ${k} leaks a Map`);
    }
    assert.equal(m.store, undefined);
});

// ---- write-through ----------------------------------------------------------

test('flush(): hashes land before obs, then sent; dataVer bumps once', async () => {
    const store = stubStore();
    const m = new CaptureModel({ store, flushMs: 60_000 });   // timer won't fire in-test
    await m.open('db');
    m.bufferObservation({ hash: 'h', time: 1 }, { hash: 'h', firstSeen: 1 });
    m.bufferObservation({ hash: 'h', time: 2 }, null);
    m.bufferSent({ time: 3, snr: 5 });
    assert.equal(m.dataVer, 0);
    await m.flush();
    const order = store.calls.map(c => c[0]);
    assert.deepEqual(order, ['open', 'putHashesMerge', 'putObs', 'putSent']);
    assert.equal(store.calls[1][1].length, 1);   // one hash record
    assert.equal(store.calls[2][1].length, 2);   // two obs records
    assert.equal(m.dataVer, 1);
    await m.flush();                              // nothing buffered
    assert.equal(m.dataVer, 1, 'clean flush must not bump dataVer');
});

test('flush() before open() is a no-op (buffers kept for later)', async () => {
    const store = stubStore();
    const m = new CaptureModel({ store, flushMs: 60_000 });
    m.bufferObservation({ hash: 'h', time: 1 }, null);
    await m.flush();
    assert.deepEqual(store.calls, [], 'nothing may hit the store before open');
    await m.open('db');
    await m.flush();
    assert.deepEqual(store.calls.map(c => c[0]), ['open', 'putObs'], 'buffered record survives to the post-open flush');
});

test('scheduled flush fires after flushMs and persists totalsProvider()', async () => {
    const store = stubStore();
    const m = new CaptureModel({ store, flushMs: 15 });
    m.totalsProvider = () => ({ totalRxCount: 7 });
    await m.open('db');
    m.bufferObservation({ hash: 'h', time: 1 }, null);
    await tick(40);
    const kinds = store.calls.map(c => c[0]);
    assert.ok(kinds.includes('putObs'), 'debounced flush ran');
    const kv = store.calls.find(c => c[0] === 'setKV');
    assert.deepEqual(kv.slice(1), ['totals', { totalRxCount: 7 }]);
    assert.equal(m.dataVer, 1);
});

test('failed open → dead model: buffers dropped, write-through no-ops', async () => {
    const store = stubStore({ openOk: false });
    const m = new CaptureModel({ store, flushMs: 5 });
    m.bufferObservation({ hash: 'pre', time: 1 }, null);   // buffered pre-open
    const ok = await m.open('db');
    assert.equal(ok, false);
    assert.equal(m.dead, true);
    assert.equal(m.ready, false);
    m.bufferObservation({ hash: 'post', time: 2 }, null);  // must be ignored
    m.bufferSent({ time: 3 });
    await tick(20);
    assert.deepEqual(store.calls.map(c => c[0]), ['open'], 'no writes ever reach a dead store');
    // the recent window still works (RAM-only session)
    m.recentSet('h', { a: 1 });
    assert.equal(m.recentSize, 1);
});

test('clearAll() wipes the recent window, buffers and disk', async () => {
    const store = stubStore();
    const m = new CaptureModel({ store, flushMs: 60_000 });
    await m.open('db');
    m.recentSet('h', {});
    m.bufferObservation({ hash: 'h', time: 1 }, { hash: 'h', firstSeen: 1 });
    await m.clearAll();
    assert.equal(m.recentSize, 0);
    assert.ok(store.calls.some(c => c[0] === 'clearAll'));
    await m.flush();
    assert.ok(!store.calls.some(c => c[0] === 'putObs'), 'cleared buffers must not flush later');
});

test('quota callback is forwarded from the store', async () => {
    const store = stubStore();
    const m = new CaptureModel({ store });
    await m.open('db');
    let hits = 0;
    m.onQuotaExceeded = () => hits++;
    store.onQuotaExceeded();   // the store fires its hook
    assert.equal(hits, 1);
});
