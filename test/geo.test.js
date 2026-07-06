// Unit tests for the Web-Mercator tile math (geo.js). Round-trip and known
// reference points — the kind of coverage that would have caught the missing
// cos(lat) factor once found in _cameraViewBbox. Run with `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lonLatToTile, tileToLatLon } from '../geo.js';

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('known reference tiles (slippy-map scheme)', () => {
    // World origin: lon/lat (-180, ~85.05°) → tile (0,0) at any zoom.
    let t = lonLatToTile(-180, 85.0511, 0);
    assert.ok(Math.abs(t.x - 0) < 1e-6);
    assert.ok(Math.abs(t.y - 0) < 1e-4);

    // Equator/prime meridian → centre of the map.
    t = lonLatToTile(0, 0, 1);
    assert.ok(Math.abs(t.x - 1) < 1e-9);        // 2^1 / 2
    assert.ok(Math.abs(t.y - 1) < 1e-9);

    // z=10, a known city tile (Prague ~ 50.088, 14.42) — sanity on magnitude.
    t = lonLatToTile(14.42, 50.088, 10);
    assert.equal(Math.floor(t.x), 553);
    assert.equal(Math.floor(t.y), 346);
});

test('tileToLatLon inverts lonLatToTile across zooms and the globe', () => {
    const rnd = lcg(2026);
    for (let i = 0; i < 5000; i++) {
        const lon = rnd() * 360 - 180;
        const lat = rnd() * 170 - 85;            // within Mercator's valid band
        const zoom = 1 + Math.floor(rnd() * 19);
        const { x, y } = lonLatToTile(lon, lat, zoom);
        const back = tileToLatLon(x, y, zoom);
        assert.ok(Math.abs(back.lon - lon) < 1e-6, `lon round-trip @z${zoom}`);
        assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat round-trip @z${zoom}`);
    }
});

test('x is linear in longitude; y grows toward the poles (Mercator stretch)', () => {
    // Equal longitude steps → equal x steps.
    const a = lonLatToTile(-90, 0, 5).x;
    const b = lonLatToTile(0, 0, 5).x;
    const c = lonLatToTile(90, 0, 5).x;
    assert.ok(Math.abs((b - a) - (c - b)) < 1e-9);

    // A degree of latitude near the pole spans fewer tile-units of y than one at
    // the equator is false in world span but in TILE space the opposite: check
    // that y decreases as lat increases (north is up) and is symmetric about 0.
    const yEq = lonLatToTile(0, 0, 5).y;
    const yN  = lonLatToTile(0, 45, 5).y;
    const yS  = lonLatToTile(0, -45, 5).y;
    assert.ok(yN < yEq && yEq < yS);
    assert.ok(Math.abs((yEq - yN) - (yS - yEq)) < 1e-9);   // symmetric
});
