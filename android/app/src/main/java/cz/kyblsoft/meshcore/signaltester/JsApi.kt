package cz.kyblsoft.meshcore.signaltester

import android.webkit.WebView
import org.json.JSONObject

/**
 * Posts calls into the page's JavaScript. All argument strings are JSON-quoted
 * so arbitrary bytes/text can't break out of the call expression. Every call is
 * marshalled onto the WebView's own thread via [WebView.post].
 *
 * The matching JS handlers live in native-bridge.js.
 */
class JsApi(webView: WebView) {

    // @Volatile: rebind() runs on the main thread while eval() is called from
    // the BLE GATT callback / serial I/O / TCP reader threads, so the field is
    // read and written across threads. Volatile guarantees those threads see
    // the freshly rebound view rather than a stale reference.
    @Volatile
    private var webView: WebView = webView

    /**
     * Point this bridge at a freshly built WebView. Used when the renderer
     * process is killed (e.g. Android reclaiming memory in the background) and
     * [MainActivity] rebuilds the WebView from scratch — the managers keep their
     * reference to this same JsApi, so only the target view changes.
     */
    fun rebind(view: WebView) { webView = view }

    private fun eval(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun q(s: String): String = JSONObject.quote(s)

    /** Settle a pending navigator.bluetooth request. */
    fun resolve(reqId: String, ok: Boolean, payloadJson: String?) {
        val payload = if (payloadJson == null) "null" else q(payloadJson)
        eval("window.__mcBleResolve(${q(reqId)}, $ok, $payload)")
    }

    /** Deliver a characteristic notification. */
    fun bleNotify(deviceId: String, serviceUuid: String, charUuid: String, base64Value: String) {
        eval("window.__mcBleNotify(${q(deviceId)}, ${q(serviceUuid)}, ${q(charUuid)}, ${q(base64Value)})")
    }

    /** Report that a device's GATT connection dropped. */
    fun bleDisconnected(deviceId: String) {
        eval("window.__mcBleDisconnected(${q(deviceId)})")
    }

    /** Report that the Bluetooth adapter was turned back on (e.g. airplane mode
     *  off), so the page can restart auto-reconnect. */
    fun bleAdapterOn() {
        eval("window.__mcBleAdapterOn && window.__mcBleAdapterOn()")
    }

    /** Push a geolocation fix. */
    fun geoUpdate(lat: Double, lon: Double, accuracy: Double, timestamp: Long) {
        eval("window.__mcGeoUpdate($lat, $lon, $accuracy, $timestamp)")
    }

    /** Report a geolocation error (code: 1=denied, 2=unavailable, 3=timeout). */
    fun geoError(code: Int, message: String) {
        eval("window.__mcGeoError($code, ${q(message)})")
    }

    /**
     * Tell the page that the location permission is now held, so the 3D map can
     * begin watching immediately — without the user having to tap "Enable
     * location". Fired right after the connect flow's permission grant.
     */
    fun locationPermissionGranted() {
        eval("window.__mcLocationPermissionGranted && window.__mcLocationPermissionGranted()")
    }

    /** Deliver a chunk of bytes received from a serial port. */
    fun serialData(portId: String, base64Value: String) {
        eval("window.__mcSerialData(${q(portId)}, ${q(base64Value)})")
    }

    /** Report that a serial port closed (unplugged or read error). */
    fun serialDisconnected(portId: String) {
        eval("window.__mcSerialDisconnected(${q(portId)})")
    }

    /** Deliver a chunk of bytes received from the WiFi/TCP socket. */
    fun wifiData(base64Value: String) {
        eval("window.__mcWifiData(${q(base64Value)})")
    }

    /** Report that the WiFi/TCP socket closed unexpectedly. */
    fun wifiClosed() {
        eval("window.__mcWifiClosed()")
    }
}
