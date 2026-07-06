// Unit tests for the Morton (Z-order) spatial index used for bounding-box map
// queries (packet-store.js). The BIGMIN range-skip is subtle bit-twiddling; a
// bug there silently drops points from the map, so this pins it with a property
// test that compares the skip-scan against brute force. Run with `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ps_qx, ps_qy, ps_morton, ps_bigmin, ps_part1by1, PS_QUANT_MAX } from '../packet-store.js';

// Deinterleave a 32-bit Morton code back into (qx, qy). x lives on the even
// bits, y on the odd bits (see ps_morton). Inverse of ps_part1by1's spread.
function deinterleave(code) {
    const compact = bits => {
        let n = bits & 0x55555555;
        n = (n | (n >>> 1)) & 0x33333333;
        n = (n | (n >>> 2)) & 0x0f0f0f0f;
        n = (n | (n >>> 4)) & 0x00ff00ff;
        n = (n | (n >>> 8)) & 0x0000ffff;
        return n >>> 0;
    };
    return { qx: compact(code >>> 0), qy: compact((code >>> 1) >>> 0) };
}

// Deterministic PRNG (LCG) so failures reproduce.
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---- quantisation ---------------------------------------------------------

test('ps_qx/ps_qy: clamp to [0, QMAX] and map corners correctly', () => {
    assert.equal(ps_qx(-180), 0);
    assert.equal(ps_qx(180), PS_QUANT_MAX);
    assert.equal(ps_qy(-90), 0);
    assert.equal(ps_qy(90), PS_QUANT_MAX);
    assert.equal(ps_qx(-999), 0);          // clamped
    assert.equal(ps_qx(999), PS_QUANT_MAX);
    assert.equal(ps_qx(0), Math.round(0.5 * PS_QUANT_MAX));
});

// ---- interleave round-trip ------------------------------------------------

test('deinterleave inverts ps_part1by1 (test helper sanity)', () => {
    for (const v of [0, 1, 2, 0xffff, 0x1234, 0xabcd]) {
        const spread = ps_part1by1(v);
        // compact of the spread must recover v
        const { qx } = deinterleave(spread);
        assert.equal(qx, v);
    }
});

test('ps_morton: x on even bits, y on odd bits; deinterleave recovers (qx,qy)', () => {
    const rnd = lcg(12345);
    for (let i = 0; i < 2000; i++) {
        const lon = rnd() * 360 - 180;
        const lat = rnd() * 180 - 90;
        const qx = ps_qx(lon), qy = ps_qy(lat);
        const { qx: dx, qy: dy } = deinterleave(ps_morton(lat, lon));
        assert.equal(dx, qx);
        assert.equal(dy, qy);
    }
});

test('ps_morton: monotone within a single row/column', () => {
    // Same latitude, increasing longitude → increasing qx → codes strictly
    // increase (x occupies the low/even bits; with qy fixed, code ~ spread(qx)).
    let prev = -1;
    for (let lon = -180; lon <= 180; lon += 5) {
        const code = ps_morton(0, lon);
        assert.ok(code >= prev, `code should be non-decreasing in lon at fixed lat`);
        prev = code;
    }
});

// ---- BIGMIN range-skip correctness (the important one) --------------------

// Reference skip-scan: walk sorted codes from zmin, using ps_bigmin to jump
// over Z-order "dead" stretches, collecting codes whose (x,y) is in the box.
function skipScan(sortedCodes, box, zmin, zmax) {
    const inBox = c => {
        const { qx, qy } = deinterleave(c);
        return qx >= box.xmin && qx <= box.xmax && qy >= box.ymin && qy <= box.ymax;
    };
    const out = [];
    let i = 0;
    while (i < sortedCodes.length) {
        const code = sortedCodes[i];
        if (code > zmax) break;
        if (code < zmin) { i++; continue; }
        if (inBox(code)) { out.push(code); i++; continue; }
        const nz = ps_bigmin(code, zmin, zmax);
        if (nz < 0 || nz <= code) break;
        while (i < sortedCodes.length && sortedCodes[i] < nz) i++;
    }
    return out;
}

test('BIGMIN skip-scan finds exactly the in-box points (vs brute force), many boxes', () => {
    const rnd = lcg(0xC0FFEE);
    // Fixed random point cloud.
    const pts = [];
    for (let i = 0; i < 4000; i++) {
        const lon = rnd() * 360 - 180, lat = rnd() * 180 - 90;
        pts.push({ qx: ps_qx(lon), qy: ps_qy(lat), code: ps_morton(lat, lon) });
    }
    const sorted = pts.map(p => p.code).sort((a, b) => a - b);

    for (let t = 0; t < 200; t++) {
        // Random box in quantised space; zmin/zmax are its SW/NE Morton corners.
        let x0 = Math.floor(rnd() * PS_QUANT_MAX), x1 = Math.floor(rnd() * PS_QUANT_MAX);
        let y0 = Math.floor(rnd() * PS_QUANT_MAX), y1 = Math.floor(rnd() * PS_QUANT_MAX);
        if (x0 > x1) [x0, x1] = [x1, x0];
        if (y0 > y1) [y0, y1] = [y1, y0];
        const box = { xmin: x0, xmax: x1, ymin: y0, ymax: y1 };
        const zmin = (ps_part1by1(x0) | (ps_part1by1(y0) << 1)) >>> 0;
        const zmax = (ps_part1by1(x1) | (ps_part1by1(y1) << 1)) >>> 0;

        const brute = pts.filter(p => p.qx >= x0 && p.qx <= x1 && p.qy >= y0 && p.qy <= y1)
                         .map(p => p.code).sort((a, b) => a - b);
        const scanned = skipScan(sorted, box, zmin, zmax).sort((a, b) => a - b);

        // Every in-box point must be found, and nothing out-of-box accepted.
        assert.deepEqual(scanned, brute,
            `box ${JSON.stringify(box)}: skip-scan missed or over-collected points`);
    }
});

test('ps_bigmin: result (when >=0) is inside the box and >= zcur', () => {
    const rnd = lcg(777);
    for (let t = 0; t < 500; t++) {
        let x0 = Math.floor(rnd() * PS_QUANT_MAX), x1 = Math.floor(rnd() * PS_QUANT_MAX);
        let y0 = Math.floor(rnd() * PS_QUANT_MAX), y1 = Math.floor(rnd() * PS_QUANT_MAX);
        if (x0 > x1) [x0, x1] = [x1, x0];
        if (y0 > y1) [y0, y1] = [y1, y0];
        const zmin = (ps_part1by1(x0) | (ps_part1by1(y0) << 1)) >>> 0;
        const zmax = (ps_part1by1(x1) | (ps_part1by1(y1) << 1)) >>> 0;
        const zcur = Math.floor(rnd() * (zmax - zmin + 1)) + zmin;
        const bm = ps_bigmin(zcur, zmin, zmax);
        if (bm < 0) continue;
        assert.ok(bm >= zcur, 'bigmin must not go backwards');
        const { qx, qy } = deinterleave(bm >>> 0);
        assert.ok(qx >= x0 && qx <= x1 && qy >= y0 && qy <= y1, 'bigmin result must be in box');
    }
});
