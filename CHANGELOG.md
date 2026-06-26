# Changelog

## [1.2.2] - 2026-06-26

### Added

- **Import multiple CSV files at once** — the file picker now accepts a
  multi-selection (including in the Android app) and merges all chosen files in
  a single import.
- **3D map keeps loading tiles while following you** — with "Center on me"
  active the map fetches new tiles as you move, but only while the map is
  on-screen and the app is in the foreground, so it doesn't waste data in the
  background.
- **Auto-reconnect after Bluetooth returns** — turning Bluetooth back on (for
  example leaving airplane mode) now retries the last device.

### Changed

- **Android 15 support and true edge-to-edge** — the app targets Android 15
  (API 35); the dark border around the UI is gone, content runs to the screen
  edges and the page background extends under the (transparent) system bars
  while staying scrollable to the very top.
- **Android app package renamed** to `cz.kyblsoft.meshcore.signaltester`
  (reserving `cz.kyblsoft.meshcore` as a namespace for future MeshCore apps). It
  installs as a new app — the previous build is not replaced.
- The Android app now shows its installed version (with build number) under
  Help → About.
- **3D map background** now matches the rest of the UI (the table background)
  instead of a flat black panel.

### Fixed

- **"Connected but no packets" after airplane mode** — turning Bluetooth off is
  now detected as a disconnect instead of leaving the app stuck "connected".
- **Empty tables after long runs** — Seen Repeaters and Received Packets are
  repopulated from disk once old data ages out of memory, so they no longer go
  blank while the charts and 3D map still show the data.
- Help → About can now be scrolled to the bottom in the Android app.
- The CSV-import prompt now reports the true number of stored packets, not just
  the small in-memory window.
- 2D charts no longer cluster every point into a single column, and recently
  imported data shows without needing to zoom; a restored chart freezes at the
  correct time.
- 3D map repeater icons are now hidden behind signal balls in front of them
  (correct depth) instead of always drawing on top.
- 3D map markers are sized from the smaller screen dimension, so they aren't
  oversized in landscape.
- The 3D map no longer flashes a white panel while you resize it in dark mode.

### Internal

- The `usb-serial-for-android` library is vendored and built from source (no
  JitPack); the build is reproducible with pinned tooling and dependency
  checksum verification, and a CI workflow builds and lints the app on every
  change.

## [1.2.1] - 2026-06-22

### Added

- **Auto-reconnect** — an optional toggle that automatically retries the last
  device after an unexpected drop, before the disconnect alarm. Shown only
  where it can actually work (not for Bluetooth in a mobile browser).
- **Nicer packet sound** — a pleasant bell whose pitch still tracks signal
  strength, plus a new "disconnect only" sound mode. The disconnect alarm now
  sounds on every unexpected drop.

### Changed

- **Location now starts automatically when you connect (Android)** — no need to
  tap the 3D map's "Enable location" button anymore.
- **Steadier location on the 3D map** — occasional GPS jumps (sudden ~200 m
  hops) are filtered out.
- **3D map zooms in to street level** even on large maps, and deep zoom is
  smoother.
- **3D camera framing** — "Center on me" no longer jerks at the end of its move,
  and repeaters are framed with a little headroom above them.

### Fixed

- 2D charts could stop updating with Display set to **All**, until you switched
  the Display window and back.
- Help (?) tooltips could appear away from their icon.
- Seen Repeaters now shows the true last RSSI/SNR, not a rounded/averaged value.
- Received Packets always lists every repeater as a column, not only the ones on
  the current page.
- 3D map selection no longer clears itself on its own.
- 3D map tiles no longer flicker while panning or zooming.
- Footer text now has proper contrast in light mode.

## [1.2.0] - 2026-06-14

### Added

- **Zoomable 2D signal charts** — wheel or pinch to zoom along the time axis,
  drag across a region to zoom into it, drag or Shift+wheel to pan. Both charts
  stay aligned; double-click or **Reset zoom** returns to the full view.
- **The full capture history is now kept on disk, not just in memory.** With
  "Auto-remove: Never" the app keeps the whole session without slowing down or
  running out of memory, and your data now survives a reload or a crash — on
  launch it asks whether to resume the previous session. Every view (charts, 3D
  map, packet table) shows the same data whatever the Display window, and CSV
  export covers the complete history.
- **More 3D map styles** — CARTO (Dark Matter, Positron, Voyager, plus no-label
  variants), Esri (Dark/Light Gray Canvas and satellite), extra OpenStreetMap
  flavours, and a **None (no map)** option. In dark mode the area around the map
  is now black.

### Changed

- **Longer history durations** — Auto-remove and Display now offer **3 h** and
  **12 h** (the little-used 10 min and 30 min were removed).
- **The 3D map's "Cluster radius" setting is gone** — nearby points are now
  grouped automatically (based on the zoom level), so there's nothing to tune.

### Fixed

- **The Android app no longer freezes on a blank screen after running for
  hours**, and recovers on its own if the system reclaims it in the background.
- **Packets captured before location was turned on are no longer placed at your
  current location on the 3D map** — points with no position aren't shown at
  all. Importing a CSV likewise never assigns the current location to rows that
  have none.
- **Connecting to a saved Bluetooth device while Bluetooth is off** now prompts
  you to turn it on, instead of silently never connecting.
- **A Bluetooth device you renamed after saving it** now connects under, and is
  re-saved with, its new name.
- **Better light/dark readability** — the map's location-status text, the 3D-map
  fullscreen button, the packet detail panel and the page footer are now legible
  in both themes, and map buttons no longer look stuck-pressed after a tap.

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
