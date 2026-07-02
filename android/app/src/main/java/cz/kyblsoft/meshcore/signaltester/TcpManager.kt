package cz.kyblsoft.meshcore.signaltester

import android.util.Base64
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors

/**
 * Owns the single active WiFi/TCP connection to a MeshCore WiFi companion and
 * bridges it to the Web-Serial-like shim in native-bridge.js.
 *
 * The companion's WiFi firmware (SerialWifiInterface) exposes the EXACT same
 * length-prefixed binary frame protocol as USB serial — 0x3c/0x3e marker plus a
 * 16-bit little-endian length — just over a raw TCP socket instead of a serial
 * line. Browsers can't open raw TCP, so we open it natively here and the web
 * side reuses its existing serial frame parser unchanged.
 *
 * Reads run on a dedicated reader thread; writes run on a single-thread executor
 * so the WebView binder thread never blocks on socket I/O.
 */
class TcpManager(private val js: JsApi) {

    private val ioExecutor = Executors.newSingleThreadExecutor()

    @Volatile private var socket: Socket? = null
    @Volatile private var output: OutputStream? = null
    @Volatile private var closing = false

    fun open(reqId: String, host: String, port: Int) {
        closeInternal()          // tear down any previous connection
        closing = false
        val t = Thread {
            val s = Socket()
            try {
                s.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
                s.tcpNoDelay = true
            } catch (e: Exception) {
                try { s.close() } catch (_: Exception) {}
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "Couldn't reach $host:$port — ${e.message}"))
                return@Thread
            }
            socket = s
            output = try { s.getOutputStream() } catch (_: Exception) { null }
            js.resolve(reqId, true, null)

            // Read loop: forward every chunk to the web side as base64.
            try {
                val input = s.getInputStream()
                val buf = ByteArray(4096)
                while (!closing) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) js.wifiData(Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP))
                }
            } catch (_: Exception) {
                // Socket reset/closed — fall through to disconnect handling.
            }
            // Only tear down / signal for the socket THIS thread owns. A quick
            // reconnect may have already installed a new socket (and reset
            // `closing`); the old reader must not close the new socket or fire a
            // phantom wifiClosed for a connection that is actually live.
            val userInitiated = closing || socket !== s
            if (socket === s) closeInternal()
            // Only signal an unexpected drop; a user-initiated close already tore
            // the web transport down.
            if (!userInitiated) js.wifiClosed()
        }
        t.isDaemon = true
        t.start()
    }

    fun write(reqId: String, base64: String) {
        ioExecutor.execute {
            val o = output
            if (o == null) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "WiFi socket not open"))
                return@execute
            }
            try {
                o.write(Base64.decode(base64, Base64.DEFAULT))
                o.flush()
                js.resolve(reqId, true, null)
            } catch (e: Exception) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "Write failed: ${e.message}"))
            }
        }
    }

    fun close() {
        closing = true
        ioExecutor.execute { closeInternal() }
    }

    private fun closeInternal() {
        closing = true
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        output = null
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 8000
    }
}
