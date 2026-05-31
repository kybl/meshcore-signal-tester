# MeshCore Signal Tester

## Live app: [meshcore.kyblsoft.cz/signal-tester](https://meshcore.kyblsoft.cz/signal-tester)

Web application for real-time monitoring of LoRa mesh traffic from a MeshCore companion radio via Bluetooth.

## Features

- **Bluetooth connection** — connects to a MeshCore companion device via Web Bluetooth; previously paired devices appear as one-click reconnect buttons
- **Packet decoding** — uses `@michaelhart/meshcore-decoder` to decode MeshCore packets; extracts type, path, repeater IDs, RSSI, SNR, and payload fields; packets are grouped by message so it's visible which repeaters forwarded which message
- **Seen repeaters table** — per-repeater statistics (RX count, max/last RSSI, max/last SNR, last seen); sortable columns
- **RSSI & SNR history charts** — scrolling time-series per repeater with noise floor estimate; click a chart dot to highlight one repeater across all views
- **Signal 3D map** — places each received packet as a dot at your GPS position; height encodes SNR (taller = higher SNR); map tile sources: Mapy.com (basic/outdoor/aerial/winter) and OpenStreetMap (standard/OpenTopoMap)
- **Received packets table** — one row per unique packet hash, one column pair (RSSI/SNR) per repeater; click a cell to expand full packet detail with ms-precision reception time and raw hex; filterable and CSV-exportable
- **Repeater ID prefix resolution** — path IDs can arrive as 1–3-byte prefixes of full 4-byte node IDs; the app progressively promotes shorter labels to longer ones, and splits columns into collision labels (e.g. `1234/1289`) when an ID turns out to be ambiguous
- **Pause / Resume** — suspend data collection without disconnecting; collection pauses automatically on disconnect and resumes on reconnect
- **Sound** — optional two-tone beep on each new packet (off / short / medium / long); first tone is a fixed 700 Hz click, second tone pitch scales with SNR (0 dB = base, ±10 dB = ±1 octave); setting persisted in localStorage
- **Auto-remove TTL** — packets older than a configurable window (default 15 min) disappear from the Messages table, charts, and 3D map; the Seen Repeaters table is not affected; setting persisted in localStorage
- **Repeater filter** — comma-separated prefix filter that applies to all sections simultaneously (table, charts, map)
- **Keep screen on** — optional toggle (default on) that prevents the screen from sleeping while collecting data; persisted in localStorage
- **Device battery** — displays BLE battery level if the device exposes the standard Battery Service (0x180F)
- **Light / dark theme** — toggle in the header; preference is persisted in localStorage

## Screenshots

<img src="docs/charts.webp" width="100%" alt="Seen Repeaters table and SNR/RSSI history charts">

*Seen Repeaters table with per-repeater statistics, SNR history chart (incoming + outgoing ★), and RSSI history with noise floor estimate.*

<img src="docs/3dmap.webp" width="100%" alt="Signal 3D map">

*Signal 3D map — each dot is positioned at the GPS location where the packet was received; height encodes SNR.*

<img src="docs/packets.webp" width="100%" alt="Received Packets table with expanded packet detail">

*Received Packets table grouped by message hash; expanded row shows full decoded packet including path, payload, and GPS position.*

## Requirements

- Chrome, Edge, or Opera (Web Bluetooth API required; Safari and Firefox are not supported)
- Page must be served over **HTTPS or localhost**

## How to use

1. Serve the directory over HTTPS or open `index.html` via `localhost`
2. Click **Connect Bluetooth** and select your MeshCore companion device
3. Packet data appears automatically as the device receives LoRa traffic

## Android app

A native Android wrapper is available for field use — see [`android/`](android/README.md).

The key benefit over a browser tab: BLE and GPS run in a **native foreground service**, so data collection keeps going with the screen off or the app in the background. A browser tab suspends and drops the Bluetooth connection when the screen turns off; the Android app doesn't.

APK releases are published on [GitHub](https://github.com/kybl/meshcore-signal-tester/releases).

**iOS:** There is no iOS version. This is a hobby project and the author doesn't own an iOS device to build or test on.

## File structure

| File | Description |
|------|-------------|
| `index.html` | Main page |
| `style.css` | Styles |
| `app.js` | Application logic (Bluetooth, decoding, rendering) |
| `signal3d.js` | Three.js-based 3D signal map |
| `native-bridge.js` | No-op on the web; bridges Bluetooth/Geolocation to native code inside the Android app |
| `vendor/` | Locally bundled JS deps (three.js, MapControls, meshcore-decoder) so the app runs fully offline |
| `android/` | Native Android wrapper for background (screen-off) capture |

## Bluetooth protocol

Uses Nordic UART Service (NUS):

| Role | UUID |
|------|------|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| Write (app → device) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| Notify (device → app) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

On connect the app sends `CMD_APP_START` (opcode `0x01`) to enable push notifications. The device then sends LoRa RX events (opcodes `0x84`, `0x88`, `0x8e`) carrying SNR, RSSI, and a raw LoRa payload, plus battery voltage events (opcode `0x0c`).

## References

- [MeshCore Decoder](https://github.com/michaelhart/meshcore-decoder) — TypeScript library for packet decoding
- [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) — MDN documentation
- [Nordic UART Service](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/libraries/bluetooth_services/services/nus.html) — NUS specification

## Author

Created by **[Aleš Janda](https://alesjanda.cz)**. Feedback, bug reports, and questions are welcome at [ales.janda@kyblsoft.cz](mailto:ales.janda@kyblsoft.cz) or via [GitHub Issues](https://github.com/kybl/meshcore-signal-tester/issues).
