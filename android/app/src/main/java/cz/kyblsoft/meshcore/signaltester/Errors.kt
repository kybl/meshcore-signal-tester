package cz.kyblsoft.meshcore.signaltester

import org.json.JSONObject

/**
 * The DOMException-style error names shared with the JS side. native-bridge.js
 * maps these onto the Web Bluetooth / Web Serial error contract, so they must
 * stay in sync with the names the web app checks for.
 */
object BridgeError {
    const val NOT_FOUND = "NotFoundError"
    const val SECURITY = "SecurityError"
    const val NETWORK = "NetworkError"
    const val INVALID_STATE = "InvalidStateError"
}

/**
 * Build the `{name, message}` JSON payload the JS bridge expects when a request
 * is rejected. Single source of truth for every transport (BLE/USB/WiFi) and
 * the activity's device pickers.
 */
fun errJson(name: String, message: String): String =
    JSONObject().put("name", name).put("message", message).toString()
