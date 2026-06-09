# Changelog

## [Unreleased]

### Added

- **Captured data is now stored on disk (IndexedDB) instead of only in memory.**
  The full session history is persisted as it is captured; only a bounded recent
  window is kept in RAM for rendering. This means:
  - "Auto-remove: Never" keeps the full history without growing memory without
    limit — it is bounded by disk storage instead of RAM.
  - Storage is isolated per browser tab, so two tabs capturing different devices
    never mix their data. On launch, if a previous session's data is present, the
    app asks whether to load it (otherwise it starts clean). A within-tab reload
    resumes silently, and on Android a renderer-crash rebuild resumes the
    in-progress session automatically. Databases of closed sessions are
    garbage-collected.
  - "Display: All" (or a window wider than the in-RAM budget) renders the signal
    charts from a **downsampled** view of the full history on disk, so showing the
    whole session no longer has to load every packet into memory at once.
  - The 3D map downsamples the full history onto a lat/lon grid whose cell size is
    estimated up-front from the region's extent and a target dot budget, then
    clamped to the screen resolution; it re-queries a finer grid for the visible
    region as you zoom/pan. A Morton (Z-order) spatial index makes the
    visible-region query a single index range scan instead of scanning all of
    history.
  - The packet table is paginated (prev/next, newest first) over the disk history
    when viewing a wide / "All" window.
  - CSV export streams the full history from disk, not just what is in memory.
  - While capturing, a wide / "All" view refreshes itself every few seconds so
    newly captured packets appear without changing the Display window. The
    refresh keeps the current map zoom and does not flip the table page you are
    reading (only the newest page updates in place).

### Fixed

- **Android app no longer freezes on a blank screen after running for hours.**
  Two causes were addressed:
  - Unbounded memory growth. With Auto-remove "Never" (the default) the heap grew
    until Android OOM-killed the WebView renderer. Memory is now bounded by a
    fixed in-RAM window (the full history lives on disk — see above).
  - If the WebView renderer was killed anyway (e.g. the OS reclaiming memory in
    the background), the app showed a permanent blank screen. It now detects this
    and rebuilds the WebView so the UI recovers instead of staying frozen.
- **Re-importing the same CSV no longer keeps adding duplicate points.** Imports
  are deduplicated against the persisted history, so importing an already-imported
  file is a no-op.
- **Cancelling the CSV import "data already loaded" prompt** no longer leaves the
  Import button stuck showing "Importing…".
- **3D map no longer loses off-screen points in wide / "All" views.** Zoom/pan
  used to replace the whole point set with only the visible region's points, so
  rotating back to a previously visible area showed missing dots. The map now
  keeps a full-extent base layer and only overlays a finer grid for the visible
  region.
- **The "my location" cone (and the device marker) no longer flicker.** Their
  ground disc and base caps sat almost coplanar with the map plane and z-fought
  with it as the marker rescaled each frame; their depth is now biased slightly
  toward the camera (polygonOffset), so they resolve above the plane while still
  behaving as normal 3D objects.
- **Moving around the 3D map with many points is much smoother.** Several
  causes were addressed: disk scans now fetch records in large batches instead
  of one round-trip per record; panning/rotating within an already-loaded region
  no longer re-queries or rebuilds geometry (only after moving a quarter of the
  view or zooming ≥25%); and, most importantly, the per-packet work during live
  capture (rebuilding the map point geometry and both tables) is now coalesced —
  the map geometry rebuild is throttled and skipped entirely while you are
  panning/rotating, and the tables refresh a few times a second instead of on
  every packet. (Movement was smooth with capture stopped, janky while capturing.)
- **"Center on me" now has a dead zone.** While following, the camera only
  glides after you once your marker leaves the central third of the view, and
  small manual map adjustments that keep the marker inside that zone no longer
  switch the follow mode off.

### Known limitations / to verify on-device

- The IndexedDB storage + downsampling + pagination paths have been
  syntax-checked but need runtime validation on a device (they cannot be
  exercised in CI without a browser and a live packet stream).

## [1.1.0] - 2026-06-07

### Added

- **Connect over USB** — plug a companion radio in with a USB cable instead of
  using Bluetooth. Devices you've connected to before show up as buttons for
  one-tap reconnecting.
- **Repeater support** — you can now plug a MeshCore repeater into USB,
  not just a companion radio; the app detects which kind it is on its own. With
  special logging firmware it shows full detail for every packet; with normal
  firmware it shows what it can read from the repeater's logs.
- **Connect over WiFi (Android app only)** — reach a WiFi companion over your
  network by typing in its IP address. Web browsers can't do this, so it works
  only in the Android app.
- **Android app niceties** — it now shows the current status in the phone's
  notification bar (with a speaker icon while beep alerts are on, and a "paused"
  marker when capture is stopped), opens web links in your normal browser, and
  closes pop-ups when you press Back.
- **3D map additions:**
  - optionally show your own device's location on the map (off by default —
    while on it keeps asking the device for its position, which can drain the
    battery faster, so leave it off when you don't need it);
  - a **Center on me** button that recentres the map and then follows you as
    you move;
  - pin repeaters to the map and point the camera at one;
  - while capturing, the map keeps the area around you loaded so you don't drift
    off the edge.
- **Disconnect warning** — a clear full-screen alert if the connection drops
  unexpectedly (cable unplugged, device reset, out of range). It stays quiet
  when you disconnect on purpose.

### Changed

- **Tidier header** — the connect/disconnect buttons and the status are grouped
  into one colour-coded box (red when disconnected, green when connected).
- **Sound is easier to notice** — when the beep-on-each-packet sound is turned
  on, its control turns yellow so you can see at a glance that it's on.
- **Clearer repeater colours** — brighter and easier to tell apart.

### Fixed

- Trace packets now show the correct route (they used to show the wrong path).
- Your contacts list no longer sometimes fails to finish loading.
- The 3D map's "Enable location" button no longer freezes when your phone's
  location is switched off — it works again once you turn location back on.
- The same Bluetooth device no longer shows up several times in your list of
  saved devices.
- The 3D map's fullscreen button now works in the Android app (it did nothing
  there before).

Plus lots of smaller improvements throughout.

## [1.0.0] - 2026-05-31

First release of MeshCore Signal Tester.
