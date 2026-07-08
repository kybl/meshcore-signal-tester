// Pure decision for live-following a 2D-chart X-axis zoom window as time
// advances while measuring. Kept browser-free so it's unit-testable (see
// test/chart-zoom.test.js); app.js (_advanceLiveZoom) calls it from the live
// tick and applies the result.
//
// Two edge cases keep an active zoom window tracking the data instead of
// standing still while new data streams in:
//   (1) followLive — the window is pinned to the live/right edge, so its right
//       edge is kept at `now` (shows the newest records).
//   (2) prune ride — a finite Display window / auto-remove is trimming old
//       points and the window's left edge has reached the prune cutoff, so the
//       window is pushed forward to sit just inside the still-visible data
//       instead of over already-removed (empty) space.
// The span is always preserved. Returns the new { tMin, tMax }, or null when
// nothing should move (no window, or neither case applies).

export function advanceZoomWindow(zoom, now, opts, followLive) {
    if (!zoom) return null;
    const span = zoom.tMax - zoom.tMin;

    // Left edge of still-visible data: whichever finite retention bounds it.
    // Display window takes precedence (it's what the chart's X axis uses); auto-
    // remove (hashLifetime) covers the Display = "All" case.
    let cutoff = -Infinity;
    if (Number.isFinite(opts?.displayLifetime)) cutoff = now - opts.displayLifetime;
    else if (Number.isFinite(opts?.hashLifetime)) cutoff = now - opts.hashLifetime;

    let tMin = zoom.tMin, tMax = zoom.tMax;
    if (followLive) {                       // (1) pinned to the live edge → follow now
        tMax = now;
        tMin = now - span;
    } else if (zoom.tMin < cutoff) {        // (2) reached the prune edge → ride it forward
        tMin = cutoff;
        tMax = cutoff + span;
    }

    if (tMin === zoom.tMin && tMax === zoom.tMax) return null;
    return { tMin, tMax };
}
