// Unit tests for the CSV import/export format (csv.js). These guard data
// integrity: a broken round-trip silently corrupts a user's captured history.
// Run with `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_HEADER, escapeCsvValue, parseCsvLine, splitCsvRecords, buildCsv, parseCsv } from '../csv.js';

// ---- escapeCsvValue -------------------------------------------------------

test('escapeCsvValue: null/undefined/empty become an empty field', () => {
    assert.equal(escapeCsvValue(null), '');
    assert.equal(escapeCsvValue(undefined), '');
    assert.equal(escapeCsvValue(''), '');
});

test('escapeCsvValue: plain values pass through; specials get quoted (RFC 4180)', () => {
    assert.equal(escapeCsvValue('hello'), 'hello');
    assert.equal(escapeCsvValue(42), '42');
    assert.equal(escapeCsvValue('a,b'), '"a,b"');
    assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');   // quotes doubled
    assert.equal(escapeCsvValue('line1\nline2'), '"line1\nline2"');
    assert.equal(escapeCsvValue('a\rb'), '"a\rb"');
});

// ---- parseCsvLine ---------------------------------------------------------

test('parseCsvLine: splits fields, honours quotes and escaped quotes', () => {
    assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);       // empty middle field
    assert.deepEqual(parseCsvLine('a,b,'), ['a', 'b', '']);       // trailing empty
    assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);      // quoted delimiter
    assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']); // escaped quotes
});

test('field round-trip: parseCsvLine(escapeCsvValue(v)) recovers v (commas/quotes)', () => {
    for (const v of ['plain', 'a,b,c', 'has "quotes"', 'mix, "both"', '', '42']) {
        assert.deepEqual(parseCsvLine(escapeCsvValue(v)), [String(v)]);
    }
});

// ---- splitCsvRecords (quote-aware record boundaries) ----------------------

test('splitCsvRecords: plain newlines split records', () => {
    assert.deepEqual(splitCsvRecords('a,b\r\nc,d'), ['a,b', 'c,d']);
    assert.deepEqual(splitCsvRecords('a\nb\nc'), ['a', 'b', 'c']);   // bare \n too
});

test('splitCsvRecords: a newline inside quotes does NOT split the record', () => {
    assert.deepEqual(splitCsvRecords('a,"x\ny",b'), ['a,"x\ny",b']);
    assert.deepEqual(splitCsvRecords('"line1\r\nline2",z\r\nnext'), ['"line1\r\nline2",z', 'next']);
});

test('splitCsvRecords: escaped "" inside a quoted field keeps quote state', () => {
    // the "" is two toggles (net inside); the following newline must still split
    assert.deepEqual(splitCsvRecords('"say ""hi""",a\nb'), ['"say ""hi""",a', 'b']);
});

test('a text field containing a newline round-trips through build → parse', () => {
    const obs = [{ time: Date.UTC(2026, 0, 1), type: 'GRP_TXT', hash: 'H', rawId: 'AA',
                   snr: 1, rssi: -90, rawHex: '', lat: 50, lon: 14,
                   text: 'first line\nsecond line', sender: 'S' }];
    const { ok, rows } = parseCsv(buildCsv({ observations: obs }));
    assert.ok(ok);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].csvText, 'first line\nsecond line');   // newline survived
    assert.equal(rows[0].lat, 50);
});

// ---- header stability -----------------------------------------------------

test('CSV_HEADER is stable (old exports must keep importing)', () => {
    assert.deepEqual(CSV_HEADER, [
        'time', 'type', 'hash', 'repeater', 'snr', 'uplink_snr',
        'rssi', 'raw_hex', 'lat', 'lon', 'text', 'sender',
    ]);
});

// ---- build → parse round-trip --------------------------------------------

test('observations round-trip through build → parse', () => {
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    const obs = [
        { time: t, type: 'GRP_TXT', hash: 'H1', rawId: '5E9F', snr: 7, rssi: -95,
          rawHex: 'ab12', lat: 50.1, lon: 14.4, text: 'hi, there', sender: 'A' },
        { time: t + 1000, type: 'ADVERT', hash: 'H2', rawId: '12AB', snr: -3.5, rssi: -110,
          rawHex: 'cd34', lat: null, lon: null, text: '', sender: '' },
    ];
    const { ok, rows } = parseCsv(buildCsv({ observations: obs }));
    assert.ok(ok);
    assert.equal(rows.length, 2);

    assert.equal(rows[0].hash, 'H1');
    assert.equal(rows[0].repeater, '5E9F');
    assert.equal(rows[0].type, 'GRP_TXT');
    assert.equal(rows[0].time, t);
    assert.equal(rows[0].snr, 7);
    assert.equal(rows[0].rssi, -95);
    assert.equal(rows[0].rawHex, 'ab12');
    assert.equal(rows[0].lat, 50.1);
    assert.equal(rows[0].lon, 14.4);
    assert.equal(rows[0].csvText, 'hi, there');   // comma survived quoting
    assert.equal(rows[0].csvSender, 'A');

    assert.equal(rows[1].snr, -3.5);
    assert.equal(rows[1].lat, null);              // empty lat/lon → null
    assert.equal(rows[1].lon, null);
});

test('a missing rssi round-trips to the documented -100 default', () => {
    const obs = [{ time: Date.UTC(2026, 0, 1), type: 'X', hash: 'H', rawId: 'AA',
                   snr: 1, rssi: null, rawHex: '', lat: null, lon: null }];
    const { rows } = parseCsv(buildCsv({ observations: obs }));
    assert.equal(rows[0].rssi, -100);
});

test('contacts round-trip through the "# CONTACT," comment lines', () => {
    const contacts = [
        { pubKeyFullHex: 'deadbeef', name: 'Node, One', lat: 50.0, lon: 14.0 },
        { pubKeyFullHex: 'cafe', name: '', lat: 0, lon: 0 },
    ];
    const parsed = parseCsv(buildCsv({ contacts, observations: [
        { time: Date.UTC(2026, 0, 1), type: 'X', hash: 'H', rawId: 'AA', snr: 0, rssi: -90 },
    ] }));
    assert.equal(parsed.contacts.length, 2);
    assert.equal(parsed.contacts[0].pubKeyFullHex, 'deadbeef');
    assert.equal(parsed.contacts[0].name, 'Node, One');   // comma in name survived
    assert.equal(parsed.contacts[0].lat, 50.0);
    assert.equal(parsed.contacts[1].name, null);          // empty name → null
});

test('sentRows are separated from observation rows on parse', () => {
    const text = buildCsv({
        observations: [{ time: Date.UTC(2026, 0, 1), type: 'X', hash: 'H', rawId: 'AA', snr: 1, rssi: -90 }],
        sentRows: [{ time: Date.UTC(2026, 0, 1, 1), col: '5E9F', snr: 4.25, lat: 50, lon: 14, label: 'Repeater 1' }],
    });
    const { ok, rows, sentRows } = parseCsv(text);
    assert.ok(ok);
    assert.equal(rows.length, 1);
    assert.equal(sentRows.length, 1);
    assert.equal(sentRows[0].repeater, '5E9F');
    // Sent SNR is written to the uplink_snr column (the importer reads
    // uplinkSnr ?? snr), so the plain snr column is empty (0) here.
    assert.equal(sentRows[0].uplinkSnr, 4.25);
    assert.equal(sentRows[0].csvText, 'Repeater 1');   // label lands in the text column
});

// ---- malformed / edge cases ----------------------------------------------

test('empty or header-only input reports ok:false', () => {
    assert.equal(parseCsv('').ok, false);
    assert.equal(parseCsv('').error, 'empty');
});

test('a header missing required columns reports a format error', () => {
    const bad = 'foo,bar\r\n1,2';
    const r = parseCsv(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'format');
});

test('rows with an unparseable time are skipped, not fatal', () => {
    const text = [
        CSV_HEADER.join(','),
        'not-a-date,X,H0,AA,1,,-90,,,,,',
        new Date(Date.UTC(2026, 0, 1)).toISOString() + ',X,H1,AA,1,,-90,,,,,',
    ].join('\r\n');
    const { ok, rows } = parseCsv(text);
    assert.ok(ok);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hash, 'H1');
});

test('a leading UTF-8 BOM is stripped before parsing', () => {
    const text = '﻿' + CSV_HEADER.join(',') + '\r\n'
        + new Date(Date.UTC(2026, 0, 1)).toISOString() + ',X,H1,AA,1,,-90,,,,,';
    const { ok, rows } = parseCsv(text);
    assert.ok(ok);
    assert.equal(rows.length, 1);
});
