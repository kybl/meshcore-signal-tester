package cz.kyblsoft.meshcore

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.UUID

/**
 * Owns the single active GATT connection and serialises GATT operations
 * (Android allows only one outstanding read/write/descriptor op at a time).
 * Results are pushed back to JavaScript through [JsApi].
 */
@SuppressLint("MissingPermission")
class BleManager(private val context: Context, private val js: JsApi) {

    private val main = Handler(Looper.getMainLooper())

    private var gatt: BluetoothGatt? = null
    private var deviceAddress: String? = null
    @Volatile private var connected = false

    private var connectReqId: String? = null

    private val opQueue = ArrayDeque<() -> Unit>()
    private var opBusy = false
    private var pendingReqId: String? = null

    fun isConnected(address: String): Boolean = connected && address == deviceAddress

    // ---- connection -----------------------------------------------------

    fun connect(reqId: String, address: String) {
        closeGatt()
        deviceAddress = address
        connectReqId = reqId
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (adapter == null || !adapter.isEnabled) {
            // BT off (or no adapter): connectGatt would just hang with no
            // callback, leaving the JS promise pending forever. Fail fast and
            // prompt, mirroring the requestDevice ("Connect Bluetooth") path.
            connectReqId = null
            if (adapter != null) main.post { Toast.makeText(context, "Please turn on Bluetooth", Toast.LENGTH_LONG).show() }
            js.resolve(reqId, false, errJson(BridgeError.INVALID_STATE, "Bluetooth is off"))
            return
        }
        val dev: BluetoothDevice = try {
            adapter.getRemoteDevice(address)
        } catch (e: Exception) {
            connectReqId = null
            js.resolve(reqId, false, errJson(BridgeError.NOT_FOUND, "Invalid device address"))
            return
        }
        main.post {
            gatt = dev.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }
    }

    fun disconnect(address: String) {
        if (address == deviceAddress) {
            closeGatt()
            // Closing the GATT often suppresses the STATE_DISCONNECTED callback,
            // so notify the page directly to settle its disconnect promise.
            js.bleDisconnected(address)
        }
    }

    private fun closeGatt() {
        try { gatt?.disconnect() } catch (_: Exception) {}
        try { gatt?.close() } catch (_: Exception) {}
        gatt = null
        connected = false
        clearQueue()
    }

    // ---- operation queue ------------------------------------------------

    // Queue mutations come from two threads (the WebView JS-bridge thread via
    // enqueue, and the GATT callback thread via complete/fail), so all access
    // is synchronized on this manager.
    @Synchronized
    private fun enqueue(reqId: String, op: () -> Unit) {
        opQueue.add {
            pendingReqId = reqId
            op()
        }
        drain()
    }

    @Synchronized
    private fun drain() {
        if (opBusy) return
        val op = opQueue.poll() ?: return
        opBusy = true
        try {
            op()
        } catch (e: Exception) {
            failPending(BridgeError.NETWORK, e.message ?: "operation failed")
        }
    }

    @Synchronized
    private fun completePending(payloadJson: String?) {
        val r = pendingReqId
        pendingReqId = null
        opBusy = false
        if (r != null) js.resolve(r, true, payloadJson)
        drain()
    }

    @Synchronized
    private fun failPending(name: String, message: String) {
        val r = pendingReqId
        pendingReqId = null
        opBusy = false
        if (r != null) js.resolve(r, false, errJson(name, message))
        drain()
    }

    @Synchronized
    private fun clearQueue() {
        opQueue.clear()
        opBusy = false
        pendingReqId = null
    }

    private fun findChar(serviceUuid: String, charUuid: String): BluetoothGattCharacteristic? {
        val s = gatt?.getService(UUID.fromString(serviceUuid)) ?: return null
        return s.getCharacteristic(UUID.fromString(charUuid))
    }

    // ---- I/O ------------------------------------------------------------

    fun write(reqId: String, serviceUuid: String, charUuid: String, base64: String, withResponse: Boolean) {
        enqueue(reqId) {
            val g = gatt ?: return@enqueue failPending(BridgeError.NETWORK, "not connected")
            val ch = findChar(serviceUuid, charUuid)
                ?: return@enqueue failPending(BridgeError.NOT_FOUND, "characteristic not found")
            val data = Base64.decode(base64, Base64.DEFAULT)
            val type = if (withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                       else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            val ok: Boolean = if (Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(ch, data, type) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    ch.writeType = type
                    ch.value = data
                    g.writeCharacteristic(ch)
                }
            }
            if (!ok) failPending(BridgeError.NETWORK, "writeCharacteristic rejected")
            // success arrives in onCharacteristicWrite
        }
    }

    fun read(reqId: String, serviceUuid: String, charUuid: String) {
        enqueue(reqId) {
            val g = gatt ?: return@enqueue failPending(BridgeError.NETWORK, "not connected")
            val ch = findChar(serviceUuid, charUuid)
                ?: return@enqueue failPending(BridgeError.NOT_FOUND, "characteristic not found")
            if (!g.readCharacteristic(ch)) failPending(BridgeError.NETWORK, "readCharacteristic rejected")
        }
    }

    fun setNotifications(reqId: String, serviceUuid: String, charUuid: String, enable: Boolean) {
        enqueue(reqId) {
            val g = gatt ?: return@enqueue failPending(BridgeError.NETWORK, "not connected")
            val ch = findChar(serviceUuid, charUuid)
                ?: return@enqueue failPending(BridgeError.NOT_FOUND, "characteristic not found")
            g.setCharacteristicNotification(ch, enable)
            val cccd = ch.getDescriptor(CCCD_UUID)
            if (cccd == null) {
                completePending(null)
                return@enqueue
            }
            val value = if (enable) BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        else BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            val ok: Boolean = if (Build.VERSION.SDK_INT >= 33) {
                g.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                run {
                    cccd.value = value
                    g.writeDescriptor(cccd)
                }
            }
            if (!ok) failPending(BridgeError.NETWORK, "writeDescriptor rejected")
            // success arrives in onDescriptorWrite
        }
    }

    // ---- GATT callbacks -------------------------------------------------

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    connected = true
                    // Negotiate a larger MTU first, so multi-hundred-byte frames
                    // (e.g. contact records) arrive in one notification instead of
                    // being capped at the 23-byte default. Discovery starts in
                    // onMtuChanged; if the request can't even be issued, start now.
                    main.post {
                        try {
                            if (!g.requestMtu(517)) g.discoverServices()
                        } catch (_: Exception) {
                            try { g.discoverServices() } catch (_: Exception) {}
                        }
                    }
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    connected = false
                    val wasConnecting = connectReqId
                    if (wasConnecting != null) {
                        connectReqId = null
                        js.resolve(wasConnecting, false, errJson(BridgeError.NETWORK, "GATT disconnected (status $status)"))
                    } else {
                        deviceAddress?.let { js.bleDisconnected(it) }
                    }
                    clearQueue()
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            // Whether or not the larger MTU was granted, proceed to discovery.
            main.post { try { g.discoverServices() } catch (_: Exception) {} }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val reqId = connectReqId ?: return
            connectReqId = null
            if (status != BluetoothGatt.GATT_SUCCESS) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "service discovery failed ($status)"))
                return
            }
            val services = JSONObject()
            for (s in g.services) {
                val chars = JSONArray()
                for (c in s.characteristics) chars.put(c.uuid.toString())
                services.put(s.uuid.toString(), chars)
            }
            js.resolve(reqId, true, JSONObject().put("services", services).toString())
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) completePending(null)
            else failPending(BridgeError.NETWORK, "write failed ($status)")
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) completePending(null)
            else failPending(BridgeError.NETWORK, "descriptor write failed ($status)")
        }

        // Read — API < 33
        @Deprecated("Deprecated in Java")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION")
            handleRead(ch.value, status)
        }

        // Read — API 33+
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            handleRead(value, status)
        }

        private fun handleRead(value: ByteArray?, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                val b64 = Base64.encodeToString(value ?: ByteArray(0), Base64.NO_WRAP)
                completePending(JSONObject().put("value", b64).toString())
            } else {
                failPending(BridgeError.NETWORK, "read failed ($status)")
            }
        }

        // Notification — API < 33
        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            handleNotify(ch.service.uuid, ch.uuid, ch.value)
        }

        // Notification — API 33+
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
            handleNotify(ch.service.uuid, ch.uuid, value)
        }

        private fun handleNotify(serviceUuid: UUID, charUuid: UUID, value: ByteArray?) {
            val b64 = Base64.encodeToString(value ?: ByteArray(0), Base64.NO_WRAP)
            js.bleNotify(deviceAddress ?: "", serviceUuid.toString(), charUuid.toString(), b64)
        }
    }

    companion object {
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
