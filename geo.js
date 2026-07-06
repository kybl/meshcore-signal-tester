// Web-Mercator tile math, extracted from signal3d.js so it can be unit-tested
// without pulling in Three.js (see test/geo.test.js). Pure functions; no
// browser or WebGL dependency.

// Fractional tile coordinates for a lon/lat at a given zoom (slippy-map scheme).
export function lonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const x = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

// Inverse of lonLatToTile: the lat/lon of a (fractional) tile coordinate.
export function tileToLatLon(tx, ty, zoom) {
    const n = Math.pow(2, zoom);
    const lon = tx / n * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;
    return { lat, lon };
}
