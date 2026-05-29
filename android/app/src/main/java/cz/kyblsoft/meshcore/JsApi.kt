package cz.kyblsoft.meshcore

import android.webkit.WebView
import org.json.JSONObject

/**
 * Posts calls into the page's JavaScript. All argument strings are JSON-quoted
 * so arbitrary bytes/text can't break out of the call expression. Every call is
 * marshalled onto the WebView's own thread via [WebView.post].
 *
 * The matching JS handlers live in native-bridge.js.
 */
class JsApi(private val webView: WebView) {

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

    /** Push a geolocation fix. */
    fun geoUpdate(lat: Double, lon: Double, accuracy: Double, timestamp: Long) {
        eval("window.__mcGeoUpdate($lat, $lon, $accuracy, $timestamp)")
    }

    /** Report a geolocation error (code: 1=denied, 2=unavailable, 3=timeout). */
    fun geoError(code: Int, message: String) {
        eval("window.__mcGeoError($code, ${q(message)})")
    }
}
