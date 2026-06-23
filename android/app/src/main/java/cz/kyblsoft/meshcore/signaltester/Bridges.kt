package cz.kyblsoft.meshcore.signaltester

import android.webkit.JavascriptInterface

/**
 * JavaScript interface exposed as `window.AndroidBle`. Methods mirror the
 * surface that native-bridge.js calls. They run on a WebView binder thread,
 * so they only dispatch into the managers and return promptly.
 */
class BleBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun requestDevice(reqId: String, filtersJson: String) {
        activity.requestDevice(reqId, filtersJson)
    }

    @JavascriptInterface
    fun getDevices(reqId: String) {
        activity.getKnownDevices(reqId)
    }

    @JavascriptInterface
    fun connect(reqId: String, deviceId: String) {
        activity.checkBatteryOptimization()
        activity.checkBackgroundLocation()
        activity.main.post {
            activity.ensureConnectPermissions {
                activity.ble.connect(reqId, deviceId)
            }
        }
    }

    @JavascriptInterface
    fun disconnect(deviceId: String) {
        activity.ble.disconnect(deviceId)
    }

    @JavascriptInterface
    fun isConnected(deviceId: String): Boolean = activity.ble.isConnected(deviceId)

    @JavascriptInterface
    fun write(reqId: String, deviceId: String, serviceUuid: String, charUuid: String, base64: String, withResponse: Boolean) {
        activity.ble.write(reqId, serviceUuid, charUuid, base64, withResponse)
    }

    @JavascriptInterface
    fun read(reqId: String, deviceId: String, serviceUuid: String, charUuid: String) {
        activity.ble.read(reqId, serviceUuid, charUuid)
    }

    @JavascriptInterface
    fun startNotifications(reqId: String, deviceId: String, serviceUuid: String, charUuid: String) {
        activity.ble.setNotifications(reqId, serviceUuid, charUuid, true)
    }

    @JavascriptInterface
    fun stopNotifications(reqId: String, deviceId: String, serviceUuid: String, charUuid: String) {
        activity.ble.setNotifications(reqId, serviceUuid, charUuid, false)
    }
}

/**
 * JavaScript interface exposed as `window.AndroidSerial`. Mirrors the subset of
 * the Web Serial API that app.js uses. Methods run on a WebView binder thread,
 * so they dispatch onto the activity/serial manager and return promptly.
 */
class SerialBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun requestPort(reqId: String, filtersJson: String) {
        activity.main.post { activity.requestSerialPort(reqId) }
    }

    @JavascriptInterface
    fun getPorts(reqId: String) {
        activity.main.post { activity.serial.getGrantedPorts(reqId) }
    }

    @JavascriptInterface
    fun open(reqId: String, portId: String, baudRate: Int) {
        activity.checkBatteryOptimization()
        activity.main.post {
            // USB doesn't need Bluetooth permissions; location is still requested
            // so GPS for the map works and the foreground service can start.
            activity.ensureConnectPermissions(includeBluetooth = false) {
                activity.serial.open(reqId, portId, baudRate)
            }
        }
    }

    @JavascriptInterface
    fun close(portId: String) {
        activity.serial.close(portId)
    }

    @JavascriptInterface
    fun write(reqId: String, portId: String, base64: String) {
        activity.serial.write(reqId, portId, base64)
    }
}

/**
 * JavaScript interface exposed as `window.AndroidWifi`. Opens a raw TCP socket
 * to a MeshCore WiFi companion (same binary frame protocol as USB serial).
 * Methods run on a WebView binder thread, so they dispatch onto the activity /
 * TcpManager and return promptly.
 */
class WifiBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun open(reqId: String, host: String, port: Int) {
        activity.checkBatteryOptimization()
        activity.main.post {
            // TCP needs no Bluetooth permission; location is still requested (as
            // for USB) so the GPS map works and the foreground service can start.
            activity.ensureConnectPermissions(includeBluetooth = false) {
                activity.wifi.open(reqId, host, port)
            }
        }
    }

    @JavascriptInterface
    fun write(reqId: String, base64: String) {
        activity.wifi.write(reqId, base64)
    }

    @JavascriptInterface
    fun close() {
        activity.wifi.close()
    }
}

/**
 * JavaScript interface exposed as `window.AndroidGeo`.
 */
class GeoBridge(private val activity: MainActivity) {

    /** Real ACCESS_*_LOCATION grant state, so the polyfilled
     *  navigator.permissions.query reports 'prompt' before the user has granted
     *  it (instead of auto-claiming 'granted'). */
    @JavascriptInterface
    fun hasPermission(): Boolean = activity.hasLocationPermission()

    @JavascriptInterface
    fun startUpdates() {
        // Request the runtime location permission first (mirrors the BLE/USB
        // connect flow) — without this the very first "Enable location" tap hit
        // a SecurityException and silently failed with "permission denied".
        activity.main.post {
            activity.ensureLocationPermission { activity.location.start() }
        }
    }

    @JavascriptInterface
    fun stopUpdates() {
        activity.location.stop()
    }

    @JavascriptInterface
    fun getCurrent() {
        activity.main.post {
            activity.ensureLocationPermission { activity.location.current() }
        }
    }
}
