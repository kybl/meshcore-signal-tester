# Changelog

## [1.2.0] - 2026-06-14

### Added

- **Zoom and pan the 2D signal charts** along the time axis — wheel or pinch to
  zoom, drag across a region to zoom into it, drag or Shift+wheel to pan. Both
  charts stay aligned; double-click or **Reset zoom** returns to the full view.
- **More 3D map styles, none needing an API key** — CARTO (Dark Matter,
  Positron, Voyager, plus no-label variants), Esri (Dark/Light Gray Canvas and
  satellite), extra OpenStreetMap flavours, and a **None (no map)** option. In
  dark mode the area around the map is now black.
- **Longer history durations** — Auto-remove and Display now offer **3 h** and
  **12 h** (the little-used 10 min and 30 min were removed).

### Changed

- **The full capture history is now kept on disk, not just in memory.** With
  "Auto-remove: Never" the app keeps the whole session without slowing down or
  running out of memory, and your data now survives a reload or a crash — on
  launch it asks whether to resume the previous session. Every view (charts, 3D
  map, packet table) shows the same data whatever the Display window, and CSV
  export covers the complete history.
- **Selecting or filtering a repeater** narrows the Received Packets table to
  just that repeater's packets, so you no longer page through empty pages.
- The Seen Repeaters **"Show all rows" toggle is now "Expand table"**, and the
  Display menu lists **"All" last**.

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
- **Seen Repeaters and the "Active"/"Repeaters" counts** now show the whole
  Display window after a long capture instead of shrinking to only the recent
  ones; old packets also correctly leave the table as they age past the Display
  window, and the charts' time span matches the window.
- **Better light/dark readability** — the map's location-status text, the 3D-map
  fullscreen button, the packet detail panel and the page footer are now legible
  in both themes, and map buttons no longer look stuck-pressed after a tap.
- **The decoded packet detail (JSON) shows again** when you expand a row in
  Received Packets.
- **3D map**: off-screen dots are no longer lost when zoomed out in wide views,
  the location markers no longer flicker, and moving around stays smooth even
  while capturing.
- **CSV import**: re-importing the same file no longer adds duplicate points,
  and cancelling the import prompt no longer leaves the button stuck on
  "Importing…".

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
