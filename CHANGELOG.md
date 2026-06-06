# Changelog

## [1.1.0] - 2026-06-06

### Added

- **USB serial connection** for companion radios (Web Serial), alongside the
  existing Bluetooth. Previously used devices appear as one-click reconnect
  buttons.
- **Repeater support over USB** — connect to a MeshCore repeater (plain-text
  CLI), auto-detected vs. a companion. On stock firmware the app polls the
  packet log and neighbour table; on a `MESH_PACKET_LOGGING` build it decodes
  the live raw packet stream for full per-packet detail including the real
  last-hop repeater ID.
- **WiFi (TCP) connection** in the Android app — a raw TCP link to a companion
  running the WiFi firmware, with a connect form and saved devices for
  one-click reconnect. (Browsers can't open raw sockets, so this is
  Android-only.)
- **Android app** — a live status notification, external links opening in the
  system browser, and hardware Back closing open overlays.
- **3D signal map** improvements:
  - optional **device location marker** showing the connected device's own
    position (a companion's live GPS fix refreshes about once a second);
  - **Center on me** follow mode that tracks you as you move;
  - **pin repeaters** on the map and aim the camera toward a known repeater;
  - while live-capturing, map tiles stay loaded around your current position so
    you don't move off the map.
- **Disconnect alarm** — a full-screen warning when an established connection
  drops unexpectedly (a deliberate disconnect doesn't trigger it).

### Changed

- Reworked the header into a colour-coded connection status frame consolidating
  the connect/disconnect controls.
- The Sound control is highlighted in yellow while sound alerts are enabled, as
  a reminder they're armed.
- Brighter, more distinct repeater colour palette.

### Fixed

- Corrected the path shown for Trace packets, which previously displayed the
  wrong route.
- Contact sync no longer gets stuck after an interrupted fetch.
- The 3D map's "Enable location" button no longer freezes when GPS is off; it
  stays usable so capture recovers once location is switched back on.
- The same Bluetooth device no longer piles up as duplicate entries in the
  saved-devices list.

Plus many smaller UX improvements throughout.

## [1.0.0] - 2026-05-31

First release of MeshCore Signal Tester.
