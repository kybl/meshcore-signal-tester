// Unit tests for SelectionModel (selection-model.js): the selection/filter
// precedence rules and the prefix-both-ways filter matching. `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionModel } from '../selection-model.js';

const make = () => new SelectionModel({ displayId: id => id });

test('select toggling reports changes; null deselects', () => {
    const s = make();
    assert.equal(s.select('AB'), true);
    assert.equal(s.col, 'AB');
    assert.equal(s.select('AB'), false, 'same value → unchanged');
    assert.equal(s.select(null), true);
    assert.equal(s.col, null);
});

test('applying a filter clears the selection (filter becomes the sole narrowing)', () => {
    const s = make();
    s.select('AB');
    assert.equal(s.setFilterTerms(['3E']), true, 'reports the cleared selection');
    assert.equal(s.col, null);
    assert.ok(s.filterActive);
    assert.equal(s.setFilterTerms([]), false, 'clearing the filter clears nothing else');
});

test('matchesFilter: prefix works both ways, per collision component; no filter passes all', () => {
    const s = make();
    assert.ok(s.matchesFilter('anything'), 'no filter → pass');
    s.setFilterTerms(['3E']);
    assert.ok(s.matchesFilter('3E2F1234'), 'term is a prefix of the column');
    s.setFilterTerms(['3E2F1234']);
    assert.ok(s.matchesFilter('3E'), 'column is a prefix of the term');
    s.setFilterTerms(['99']);
    assert.ok(!s.matchesFilter('3E2F'));
    assert.ok(s.matchesFilter('3E2F/9911'), 'collision column matches via either component');
});

test('narrowFn precedence: selection wins over filter; exact match for selection', () => {
    const s = make();
    assert.equal(s.narrowFn(), null);
    s.setFilterTerms(['3E']);
    let fn = s.narrowFn();
    assert.ok(fn('3E2F') && !fn('99'), 'filter narrowing');
    s.select('99AA');               // select while a filter is active
    fn = s.narrowFn();
    assert.ok(fn('99AA') && !fn('3E2F'), 'selection narrows exactly, beating the filter');
});

test('narrowKey identifies the narrowing distinctly', () => {
    const s = make();
    assert.equal(s.narrowKey(), '');
    s.setFilterTerms(['3E', '99']);
    assert.equal(s.narrowKey(), 'f:3E\x9999'.replace('\x99', '\x1f'));
    s.select('AB');
    assert.equal(s.narrowKey(), 's:AB');
});
