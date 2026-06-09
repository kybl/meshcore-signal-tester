# Changelog

## [Unreleased]

### Added

- **Captured data is now stored on disk (IndexedDB) instead of only in memory.**
  The full session history is persisted as it is captured; only a bounded recent
  window is kept in RAM for rendering. This means:
  - "Auto-remove: Never" keeps the full history without growing memory without
    limit — it is bounded by disk storage instead of RAM.
  - Captured data survives a WebView renderer crash / app restart: it is replayed
    back from disk on startup.
  - "Display: All" (or a window wider than the in-RAM budget) renders the signal
    charts from a **downsampled** view of the full history on disk, so showing the
    whole session no longer has to load every packet into memory at once.
  - The 3D map downsamples the full history onto a lat/lon grid whose cell size is
    estimated up-front from the region's extent and a target dot budget, then
    clamped to the screen resolution; it re-queries a finer grid for the visible
    region as you zoom/pan.
  - The packet table is paginated (prev/next, newest first) over the disk history
    when viewing a wide / "All" window.
  - CSV export streams the full history from disk, not just what is in memory.

### Fixed

- **Android app no longer freezes on a blank screen after running for hours.**
  Two causes were addressed:
  - Unbounded memory growth. With Auto-remove "Never" (the default) the heap grew
    until Android OOM-killed the WebView renderer. Memory is now bounded by a
    fixed in-RAM window (the full history lives on disk — see above).
  - If the WebView renderer was killed anyway (e.g. the OS reclaiming memory in
    the background), the app showed a permanent blank screen. It now detects this
    and rebuilds the WebView so the UI recovers instead of staying frozen.

### Known limitations / to verify on-device

- Wide / "All" views (charts, map, table) are a point-in-time snapshot of the
  disk history, refreshed when the Display window changes (and, for the map, on
  zoom/pan); they do not update continuously while capturing. The live narrow
  window updates in real time as before.
- The map's full-history regrid scans the time range on each (debounced) zoom;
  on very large histories this could be slow without a spatial index.
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
