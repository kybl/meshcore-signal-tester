// Unit tests for ps_mergeHashRec (packet-store.js) — the never-regress merge
// of two per-hash records. Used both against the on-disk record and to
// pre-merge intra-batch duplicates in putHashesMerge (two records with the
// same hash in one flush batch used to clobber each other: each get() read
// the pre-transaction state, so the later put dropped the earlier record's
// contribution). `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ps_mergeHashRec } from '../packet-store.js';

test('keeps the earliest firstSeen from either side', () => {
    const m = ps_mergeHashRec({ hash: 'h', firstSeen: 50 }, { hash: 'h', firstSeen: 30 });
    assert.equal(m.firstSeen, 30);
    const m2 = ps_mergeHashRec({ hash: 'h', firstSeen: 30 }, { hash: 'h', firstSeen: 50 });
    assert.equal(m2.firstSeen, 30);
});

test('existing type/meta win; nulls are filled from the newer record', () => {
    const m = ps_mergeHashRec(
        { hash: 'h', firstSeen: 1, type: 'AD', meta: { a: 1 } },
        { hash: 'h', firstSeen: 2, type: 'GT', meta: { b: 2 } });
    assert.equal(m.type, 'AD');
    assert.deepEqual(m.meta, { a: 1 });
    const m2 = ps_mergeHashRec(
        { hash: 'h', firstSeen: 1, type: null, meta: null },
        { hash: 'h', firstSeen: 2, type: 'GT', meta: { b: 2 } });
    assert.equal(m2.type, 'GT');
    assert.deepEqual(m2.meta, { b: 2 });
});

test('merge is associative over a batch (fold order does not matter)', () => {
    const recs = [
        { hash: 'h', firstSeen: 40, type: null, meta: { x: 1 } },
        { hash: 'h', firstSeen: 20, type: 'AD', meta: null },
        { hash: 'h', firstSeen: 30, type: 'GT', meta: { y: 2 } },
    ];
    const ltr = recs.reduce((a, b) => ps_mergeHashRec(a, b));
    assert.equal(ltr.firstSeen, 20);
    assert.equal(ltr.type, 'AD', 'first non-null type in batch order wins');
    assert.deepEqual(ltr.meta, { x: 1 }, 'first non-null meta in batch order wins');
});
