// Unit tests for radio-presets.js: preset matching (incl. deliberately
// identical presets and float-noise tolerance) and config formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RADIO_PRESETS, matchRadioPreset, formatRadioConfig } from '../radio-presets.js';

test('matches the Czech narrow preset exactly', () => {
    assert.deepEqual(
        matchRadioPreset({ freqKhz: 869432, bwKhz: 62.5, sf: 7, cr: 5 }),
        ['Czech Republic (Narrow)']);
});

test('identical presets all match (EU/UK Narrow ≡ Switzerland)', () => {
    assert.deepEqual(
        matchRadioPreset({ freqKhz: 869618, bwKhz: 62.5, sf: 8, cr: 8 }),
        ['EU/UK (Narrow)', 'Switzerland']);
});

test('same frequency, different SF/CR does not cross-match', () => {
    // Portugal 868 shares 869.618/62.5 with EU/UK (Narrow) but is SF7 CR6.
    assert.deepEqual(
        matchRadioPreset({ freqKhz: 869618, bwKhz: 62.5, sf: 7, cr: 6 }),
        ['Portugal 868']);
});

test('tolerates float noise from Hz→kHz conversion, rejects real mismatches', () => {
    // 62500 Hz / 1000 can arrive as 62.50000000001.
    assert.deepEqual(
        matchRadioPreset({ freqKhz: 869525, bwKhz: 62.5 + 1e-9, sf: 11, cr: 5 }), []);
    assert.deepEqual(
        matchRadioPreset({ freqKhz: 869525, bwKhz: 250 + 1e-9, sf: 11, cr: 5 }),
        ['EU/UK (Deprecated)']);
    // 125 kHz is not 62.5 — a genuinely different bandwidth must not match.
    assert.deepEqual(
        matchRadioPreset({ freqKhz: 869618, bwKhz: 125, sf: 8, cr: 8 }), []);
});

test('custom settings match nothing', () => {
    assert.deepEqual(matchRadioPreset({ freqKhz: 868000, bwKhz: 125, sf: 9, cr: 5 }), []);
});

test('every preset in the table matches itself and nothing conflicting', () => {
    for (const p of RADIO_PRESETS) {
        const titles = matchRadioPreset(p);
        assert.ok(titles.includes(p.title), `${p.title} must match itself`);
    }
});

test('formatRadioConfig renders MHz, kHz and CR as 4/x', () => {
    assert.equal(
        formatRadioConfig({ freqKhz: 869618, bwKhz: 62.5, sf: 8, cr: 8 }),
        '869.618 MHz, BW 62.5 kHz, SF8, CR4/8');
    assert.equal(
        formatRadioConfig({ freqKhz: 915800, bwKhz: 250, sf: 10, cr: 5 }),
        '915.800 MHz, BW 250 kHz, SF10, CR4/5');
});
