// Unit tests for ContactsDirectory (contacts-directory.js): collision-aware
// prefix lookups, pubkey → column resolution, persistence discipline and the
// incremental-sync marker. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContactsDirectory } from '../contacts-directory.js';

function makeDir({ ready = true } = {}) {
    const persisted = [];
    let countChanges = 0;
    const dir = new ContactsDirectory({
        ready: () => ready,
        persist: p => persisted.push(p),
        onCountChanged: () => countChanges++,
    });
    return { dir, persisted, counts: () => countChanges };
}

const C = (pk, name, lat = 0, lon = 0) =>
    ({ pubKeyFullHex: pk, name, type: null, lat, lon, lastAdvert: 0, lastmod: 0 });

const tick = ms => new Promise(r => setTimeout(r, ms));

test('byPrefix matches either component of a collision column', () => {
    const { dir } = makeDir();
    dir.put(C('12ab0000', 'Alpha'));
    dir.put(C('34cd0000', 'Beta'));
    dir.put(C('ffff0000', 'Gamma'));
    // plain column (upper-case, like real column keys)
    assert.deepEqual(dir.byPrefix('12AB').map(c => c.name), ['Alpha']);
    // collision column matches both components; the literal "a/b" matches no pubkey
    assert.deepEqual(dir.byPrefix('12AB/34CD').map(c => c.name).sort(), ['Alpha', 'Beta']);
    assert.deepEqual(dir.byPrefix('direct'), []);
});

test('nameForCol: single name, or "a / b" for a collision column', () => {
    const { dir } = makeDir();
    dir.put(C('12ab0000', 'Alpha'));
    dir.put(C('34cd0000', null));
    assert.equal(dir.nameForCol('12AB'), 'Alpha');
    assert.equal(dir.nameForCol('12AB/34CD'), 'Alpha / ?');
    assert.equal(dir.nameForCol('99'), null);
});

test('gpsFor/withGps: only named contacts with a position; withGps dedupes', () => {
    const { dir } = makeDir();
    dir.put(C('12ab0000', 'HasGps', 50.1, 14.4));
    dir.put(C('12cd0000', 'NoGps', 0, 0));          // position not configured
    dir.put(C('34ef0000', null, 49.0, 15.0));       // no name
    assert.deepEqual(dir.gpsFor('12').map(c => c.name), ['HasGps']);
    // the same contact matched via two overlapping columns appears once
    assert.equal(dir.withGps(['12', '12AB']).length, 1);
});

test('colForPubKey: longest matching component wins; case-insensitive; original key returned', () => {
    const { dir } = makeDir();
    const cols = ['12', '12AB34', 'FF/12AB', 'direct'];
    assert.equal(dir.colForPubKey('12ab34cdef', cols), '12AB34');   // longest prefix
    assert.equal(dir.colForPubKey('ff001122', cols), 'FF/12AB');    // via collision component
    assert.equal(dir.colForPubKey('99999999', cols), null);
    assert.equal(dir.colForPubKey(null, cols), null);
});

test('put persists (debounced) and bumps the count hook', async () => {
    const { dir, persisted, counts } = makeDir();
    dir.put(C('aa00', 'One'));
    dir.put(C('bb00', 'Two'));
    assert.equal(counts(), 2);
    assert.equal(persisted.length, 0, 'debounced — nothing yet');
    await tick(1100);
    assert.equal(persisted.length, 1, 'one batched persist');
    assert.equal(persisted[0].entries.length, 2);
    assert.equal(persisted[0].lastmod, 0);
});

test('persist is skipped while the store is not ready', async () => {
    const { dir, persisted } = makeDir({ ready: false });
    dir.put(C('aa00', 'One'));
    await tick(1100);
    assert.equal(persisted.length, 0);
});

test('restore fills entries + lastmod without re-persisting', async () => {
    const { dir, persisted, counts } = makeDir();
    dir.restore({ entries: [C('aa00', 'One'), { bogus: true }], lastmod: 777 });
    assert.equal(dir.size, 1, 'entries without a pubkey are skipped');
    assert.equal(dir.lastmod, 777);
    assert.equal(counts(), 1);
    await tick(1100);
    assert.equal(persisted.length, 0, 'restore must not write back what it just read');
});

test('clear wipes entries + marker and cancels a pending persist', async () => {
    const { dir, persisted } = makeDir();
    dir.put(C('aa00', 'One'));
    dir.lastmod = 123;
    dir.clear();
    assert.equal(dir.size, 0);
    assert.equal(dir.lastmod, 0);
    await tick(1100);
    assert.equal(persisted.length, 0, 'pending persist cancelled — must not re-write after clearAll');
});
