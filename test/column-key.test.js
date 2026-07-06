// Unit tests for the repeater column-key semantics (column-key.js).
// Run with `node --test` (Node 18+, no dependencies).
//
// These pin the collision behaviour that used to be re-implemented ad hoc
// across app.js / signal3d.js and produced a recurring class of bugs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    idPrecision, idSuffix, colHead, components, colsOverlap,
    colMinPrecision, colMatchesRawId, colMatchesRawIdReadonly,
    resolveColumn, resolveColumnReadonly,
} from '../column-key.js';

// Replay resolveColumn's events onto a column list exactly as the app shell
// does (renameColumnKey's in-place replace / merge-on-collision, _splitColumn's
// push, and add). Returns { key, cols } so a test can assert both.
function resolve(rawId, columns, minPrec = {}) {
    const { key, events } = resolveColumn(rawId, columns, col => minPrec[col]);
    const cols = columns.slice();
    for (const ev of events) {
        if (ev.type === 'add') { if (!cols.includes(ev.key)) cols.push(ev.key); }
        else if (ev.type === 'split') { if (!cols.includes(ev.collisionKey)) cols.push(ev.collisionKey); }
        else if (ev.type === 'rename') {
            const oi = cols.indexOf(ev.from);
            if (oi < 0) continue;
            if (cols.indexOf(ev.to) >= 0) cols.splice(oi, 1); else cols[oi] = ev.to;
        }
    }
    return { key, cols, events };
}

// ---- leaf helpers ---------------------------------------------------------

test('idPrecision: bytes = hex length / 2; pseudo & collision keys are 4', () => {
    assert.equal(idPrecision('5E'), 1);
    assert.equal(idPrecision('5E9F'), 2);
    assert.equal(idPrecision('5E9F12'), 3);
    assert.equal(idPrecision('direct'), 4);
    assert.equal(idPrecision('unknown'), 4);
    assert.equal(idPrecision('5E/AB'), 4);
});

test('idSuffix: leading bytes, upper-cased (ids are high-byte-first)', () => {
    assert.equal(idSuffix('5e9f', 1), '5E');
    assert.equal(idSuffix('5e9f', 2), '5E9F');
    assert.equal(idSuffix('5E9F', 4), '5E9F'); // asking for more bytes than present
});

test('colHead: first component of a (possibly collision) key', () => {
    assert.equal(colHead('5E9F'), '5E9F');
    assert.equal(colHead('5E9F/AB12'), '5E9F');
});

test('components: prefixes of a key; none for pseudo cols', () => {
    assert.deepEqual(components('5E9F'), ['5E9F']);
    assert.deepEqual(components('5E/AB/CD'), ['5E', 'AB', 'CD']);
    assert.deepEqual(components('direct'), []);
    assert.deepEqual(components('unknown'), []);
    assert.deepEqual(components(''), []);
});

test('colsOverlap: equal or sharing any "/"-segment', () => {
    assert.ok(colsOverlap('5E', '5E'));
    assert.ok(colsOverlap('5E', '5E/AB'));      // component of a collision
    assert.ok(colsOverlap('5E/AB', 'AB'));      // second component
    assert.ok(colsOverlap('5E/AB', 'AB/CD'));   // shared component
    assert.ok(!colsOverlap('5E', 'AB'));
    assert.ok(!colsOverlap('5E/AB', 'CD/EF'));
    assert.ok(!colsOverlap('direct', '5E'));
    assert.ok(!colsOverlap('5E', ''));
});

test('colMinPrecision: stored minPrec wins, else head precision', () => {
    assert.equal(colMinPrecision('5E9F', undefined), 2);
    assert.equal(colMinPrecision('5E9F', 1), 1);            // was promoted from a 1-byte id
    assert.equal(colMinPrecision('5E9F/AB12', undefined), 2);
    assert.equal(colMinPrecision('direct', undefined), 4);
});

test('colMatchesRawId: compares at the shorter precision; honours stored minPrec', () => {
    // exact 2-byte column only matches the same 2 bytes
    assert.ok(colMatchesRawId('5E9F', '5E9F', undefined));
    assert.ok(!colMatchesRawId('5E9F', '5EAB', undefined));
    // a shorter id matches at its own (shorter) precision
    assert.ok(colMatchesRawId('5E9F', '5E', undefined));
    // stored minPrec 1 lets the promoted column catch a differing 2-byte sibling
    // at the shared first byte (this is what triggers a later split)
    assert.ok(colMatchesRawId('5E9F', '5EAB', 1));
    assert.ok(!colMatchesRawId('direct', '5E', undefined));
});

test('colMatchesRawIdReadonly: no stored-minPrec knowledge', () => {
    assert.ok(colMatchesRawIdReadonly('5E9F', '5E'));       // short id, head match
    assert.ok(colMatchesRawIdReadonly('5E/AB', '5E'));      // matches head component
    assert.ok(!colMatchesRawIdReadonly('5E9F', '5EAB'));    // differ at full precision
    assert.ok(!colMatchesRawIdReadonly('unknown', '5E'));
});

// ---- resolveColumn decisions ---------------------------------------------

test('resolveColumn: creates a bare column for a first-seen id', () => {
    const r = resolve('5E9F', []);
    assert.equal(r.key, '5E9F');
    assert.deepEqual(r.cols, ['5E9F']);
});

test('resolveColumn: exact match returns the column with no side effects', () => {
    const r = resolve('5E9F', ['5E9F']);
    assert.equal(r.key, '5E9F');
    assert.deepEqual(r.events, []);
    assert.deepEqual(r.cols, ['5E9F']);
});

test('resolveColumn: distinct full-precision siblings stay separate', () => {
    const r = resolve('5EAB', ['5E9F']);           // same 1st byte, differ at 2nd
    assert.equal(r.key, '5EAB');
    assert.deepEqual(r.cols, ['5E9F', '5EAB']);    // NOT a collision (both 2 bytes)
});

test('resolveColumn: a short ambiguous id creates the sorted collision key', () => {
    const r = resolve('5E', ['5E9F', '5EAB']);     // "5E" matches both siblings
    assert.equal(r.key, '5E9F/5EAB');
    assert.ok(r.cols.includes('5E9F/5EAB'));
    // key components are sorted
    assert.equal(r.key, r.key.split('/').slice().sort().join('/'));
});

test('resolveColumn: a more-precise id promotes the column label', () => {
    const r = resolve('5E9F', ['5E']);             // 2 bytes over a 1-byte column
    assert.equal(r.key, '5E9F');
    assert.deepEqual(r.cols, ['5E9F']);            // renamed in place
});

test('resolveColumn: promotion is mirrored into collision keys that contain the component', () => {
    // "5E" and "AB" collided into "5E/AB"; a precise "5E9F" refines the "5E" part
    const r = resolve('5E9F', ['5E', 'AB', '5E/AB'], { '5E/AB': 1 });
    assert.equal(r.key, '5E9F');
    assert.ok(r.cols.includes('5E9F'));
    assert.ok(r.cols.includes('5E9F/AB'));         // collision key relabelled
    assert.ok(!r.cols.includes('5E/AB'));          // stale label gone
    assert.ok(!r.cols.includes('5E'));
});

test('resolveColumn: an optimistically-promoted column splits when a real sibling arrives', () => {
    // "5E9F" was promoted from a 1-byte id (stored minPrec 1); now "5EAB" arrives
    const r = resolve('5EAB', ['5E9F'], { '5E9F': 1 });
    assert.equal(r.key, '5EAB');
    assert.ok(r.cols.includes('5E9F'));
    assert.ok(r.cols.includes('5EAB'));
    assert.ok(r.cols.includes('5E9F/5EAB'));       // ambiguous packets go here
    assert.ok(r.events.some(e => e.type === 'split'));
});

test('resolveColumn: a precise id refines a component inside a collision-only key', () => {
    const r = resolve('12AB', ['12/34'], { '12/34': 1 });  // refine "12" -> "12AB"
    assert.equal(r.key, '12AB/34');
    assert.deepEqual(r.cols, ['12AB/34']);
});

test('resolveColumn: a new sibling widens the collision key and becomes its own column', () => {
    // "12AB" and "12CD" collided into "12AB/12CD" via a 1-byte "12" (minPrec 1);
    // "12EF" is a new sibling under the same short prefix.
    const r = resolve('12EF', ['12AB/12CD'], { '12AB/12CD': 1 });
    assert.equal(r.key, '12EF');                   // its own specific column
    assert.ok(r.cols.includes('12EF'));
    assert.ok(r.cols.includes('12AB/12CD/12EF'));  // widened, sorted
    assert.ok(!r.cols.includes('12AB/12CD'));
});

test('resolveColumn: a short ambiguous id stays in the existing collision key', () => {
    const r = resolve('12', ['12AB/12CD'], { '12AB/12CD': 1 });
    assert.equal(r.key, '12AB/12CD');              // dest unchanged, no new column
    assert.deepEqual(r.cols, ['12AB/12CD']);
    assert.deepEqual(r.events, []);
});

test('resolveColumn: direct is idempotent and self-contained', () => {
    assert.deepEqual(resolve('direct', []).cols, ['direct']);
    assert.deepEqual(resolve('direct', ['direct']).events, []);
});

// ---- resolveColumnReadonly (disk attribution) ----------------------------

test('resolveColumnReadonly: pseudo cols and exact matches pass through', () => {
    assert.equal(resolveColumnReadonly('direct', ['direct']), 'direct');
    assert.equal(resolveColumnReadonly('unknown', []), 'unknown');
    assert.equal(resolveColumnReadonly('5E9F', ['5E9F']), '5E9F');
});

test('resolveColumnReadonly: an id ambiguous over two siblings resolves to the collision key, not the first sibling', () => {
    // The reported bug: order put a specific sibling before the collision, so a
    // short ambiguous id resolved to it and the collision column got no rows.
    const cols = ['5E9F', '5EAB', '5E9F/5EAB'];
    assert.equal(resolveColumnReadonly('5E', cols), '5E9F/5EAB');
    // ...regardless of column order
    assert.equal(resolveColumnReadonly('5E', ['5E9F/5EAB', '5E9F', '5EAB']), '5E9F/5EAB');
});

test('resolveColumnReadonly: a specific id still resolves to its own column', () => {
    const cols = ['5E9F', '5EAB', '5E9F/5EAB'];
    assert.equal(resolveColumnReadonly('5E9F', cols), '5E9F');
    assert.equal(resolveColumnReadonly('5EAB', cols), '5EAB');
});

test('resolveColumnReadonly: an id matching only a collision key resolves to it', () => {
    assert.equal(resolveColumnReadonly('12', ['12AB/12CD']), '12AB/12CD');
});

test('resolveColumnReadonly: an unknown id resolves to itself (own column)', () => {
    assert.equal(resolveColumnReadonly('99', ['5E9F', '5EAB']), '99');
});

// ---- invariants -----------------------------------------------------------

test('invariant: resolving is idempotent (re-resolve yields the same key, no events)', () => {
    const seqs = [
        ['5E9F', '5EAB', '5E', 'AB12', 'AB', '12'],
        ['12AB', '12CD', '12', '12EF', '34', '3456'],
    ];
    for (const seq of seqs) {
        let cols = [];
        const minPrec = {};
        for (const id of seq) {
            const r = resolve(id, cols, minPrec);
            cols = r.cols;
            // model the stored minPrecision the app would keep: the shortest
            // id precision ever folded into the resulting key.
            minPrec[r.key] = Math.min(minPrec[r.key] ?? Infinity, idPrecision(id));
        }
        // Re-resolving every id now must be a no-op (points to an existing col).
        for (const id of seq) {
            const before = cols.slice();
            const r = resolve(id, cols, minPrec);
            assert.deepEqual(r.cols, before, `re-resolving ${id} changed columns`);
        }
    }
});

test('invariant: every collision key is sorted and has unique components', () => {
    let cols = [];
    const minPrec = {};
    for (const id of ['5E9F', '5EAB', '5E', '5ECD', 'AB', '5E12']) {
        const r = resolve(id, cols, minPrec);
        cols = r.cols;
        minPrec[r.key] = Math.min(minPrec[r.key] ?? Infinity, idPrecision(id));
    }
    for (const col of cols) {
        if (!col.includes('/')) continue;
        const comps = col.split('/');
        assert.deepEqual(comps, comps.slice().sort(), `collision ${col} not sorted`);
        assert.equal(new Set(comps).size, comps.length, `collision ${col} has duplicate components`);
    }
});
