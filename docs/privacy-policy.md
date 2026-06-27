# Privacy Policy — MeshCore Signal Tester

_Last updated: 2026-06-23_

MeshCore Signal Tester ("the app") is a free, open-source tool for monitoring
mesh signal from MeshCore devices. This policy explains what the app
accesses and where that data goes.

**Short version: all data the app captures stays on your device. The developer
operates no servers, collects nothing, and uses no analytics, advertising, or
tracking.**

## What the app accesses

- **Location (GPS), including in the background.** Used to tag each received
  packet with the position where it was received, to place packets on the 3D
  map, and to follow your position while you walk. Background access is needed
  so capture keeps working with the screen off. Your location is stored only on
  your device and is never transmitted by the app.
- **Bluetooth, USB, and Wi-Fi (local network).** Used to connect to your
  MeshCore companion radio or repeater and receive packets. The app talks
  only to the device you choose; it does not scan or contact anything else.
- **On-device storage.** Captured packets, signal history, and your settings are
  saved locally (in the app's WebView storage / IndexedDB) so a session survives
  a reload or restart. You can clear it from within the app (auto-remove, or by
  starting a new session).

## Data you choose to export

CSV export writes captured data to a file **you pick**, via the system file
picker. The app does not upload it anywhere; what happens to that file
afterwards is up to you.

## Network connections

The app itself sends no telemetry. The only outbound network traffic is **map
tiles**, fetched from third-party tile servers only while you are online and
viewing the map. Those providers necessarily see your IP address and the map
area being requested. Depending on the map style you select, the provider may
be Mapy.com, OpenStreetMap (and variants such as OpenTopoMap, CyclOSM,
Humanitarian), CARTO, or Esri. Their use of that request data is governed by
their own privacy policies. Choose the **None (no map)** style to make no tile
requests at all.

## Permissions and why

- **Location (fine/coarse, background)** — geotag packets, 3D map, screen-off
  capture.
- **Bluetooth / Nearby devices** — connect to the MeshCore device.
- **Notifications** — show the ongoing "capture running" notification.
- **Foreground service / wake lock** — keep the connection and GPS alive with
  the screen off.
- **Internet** — load map tiles (only when online).

## Data sharing and sale

None. The app shares no data with the developer or any third party, and sells
no data. There are no user accounts.

## Children

The app is a technical tool with no content directed at children and collects
no personal data.

## Changes

This policy may be updated; the date at the top reflects the latest revision.

## Contact

Aleš Janda — <ales.janda@kyblsoft.cz>
Source code: https://github.com/kybl/meshcore-signal-tester
