# MeshCore RX Monitor

Web application for monitoring RX logs from a MeshCore mesh network via Bluetooth.

## Features

- **Bluetooth connection**: Connects to a MeshCore companion device via Web Bluetooth API
- **Packet decoding**: Uses the `@michaelhart/meshcore-decoder` library to decode MeshCore packets
- **Visualization**: Each captured message hash is displayed as a card with repeater history
- **Auto-cleanup**: Old cards (older than 5 minutes) disappear automatically
- **Real-time statistics**: Tracks active hash count, total RX count, and repeater count

## How to use

1. Open `index.html` in a web browser (Chrome, Edge, or Opera)
   - **Important**: Web Bluetooth API requires HTTPS or localhost

2. Click the "Connect Bluetooth" button

3. Select your MeshCore device from the list

4. The app will automatically start monitoring RX logs and displaying cards for each hash

## Application structure

- `index.html` - Main HTML page
- `style.css` - Application styles
- `app.js` - JavaScript logic with MeshCore decoder

## Technical details

### Bluetooth communication

The app uses Nordic UART Service (NUS) for communication:
- Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- TX Characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e` (device → app)

### Packet decoding

The app uses the `@michaelhart/meshcore-decoder` npm library:
- Automatically decodes binary MeshCore packets
- Extracts a path-independent message hash (hashed from payload only)
- Identifies repeaters from routing information

### Data display

For each message hash:
- Displays a truncated hash
- Time of first capture
- List of repeaters with signal strength (RSSI, SNR)
- Progress bar showing remaining lifetime

### Configuration

Card lifetime can be changed in `app.js`:

```javascript
this.HASH_LIFETIME = 300000; // 5 minutes in milliseconds
```

## Supported browsers

Web Bluetooth API is supported in:
- Google Chrome (desktop & Android)
- Microsoft Edge
- Opera

Safari and Firefox do not support Web Bluetooth.

## Security

- The app requires HTTPS or localhost
- Bluetooth connection requires user consent
- No data is sent to any server

## References

- [MeshCore Decoder](https://github.com/michaelhart/meshcore-decoder) - TypeScript library for packet decoding
- [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) - MDN documentation
- [Nordic UART Service](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/libraries/bluetooth_services/services/nus.html) - NUS specification
