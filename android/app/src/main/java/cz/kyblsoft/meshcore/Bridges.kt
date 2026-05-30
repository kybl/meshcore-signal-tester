package cz.kyblsoft.meshcore

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
 * JavaScript interface exposed as `window.AndroidGeo`.
 */
class GeoBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun startUpdates() {
        activity.location.start()
    }

    @JavascriptInterface
    fun stopUpdates() {
        activity.location.stop()
    }

    @JavascriptInterface
    fun getCurrent() {
        activity.location.current()
    }
}
