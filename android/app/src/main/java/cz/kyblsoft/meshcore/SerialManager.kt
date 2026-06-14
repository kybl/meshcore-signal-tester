package cz.kyblsoft.meshcore

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Owns the single active USB serial connection and bridges it to the
 * navigator.serial polyfill in native-bridge.js. Reads run on the
 * usb-serial-for-android [SerialInputOutputManager] thread; writes run on a
 * dedicated single-thread executor so the WebView binder thread never blocks.
 *
 * Ports are identified to JavaScript by [UsbDevice.getDeviceName] (stable while
 * the device stays attached). The web app matches saved entries by USB
 * vendor/product id, so a re-attached device with a new device name still
 * reconnects.
 */
@SuppressLint("MissingPermission")
class SerialManager(private val context: Context, private val js: JsApi) {

    private val main = Handler(Looper.getMainLooper())
    private val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null
    private var openPortId: String? = null

    // Drivers discovered during requestPort / getPorts, keyed by portId, so
    // open() (on the I/O thread) can find the device the page asked for.
    private val knownDrivers = ConcurrentHashMap<String, UsbSerialDriver>()

    private var permReqId: String? = null
    private var receiverRegistered = false

    private fun portIdFor(device: UsbDevice): String = device.deviceName

    // Recognise a device via the built-in probe table, falling back to a plain
    // CDC-ACM driver for any device exposing a CDC/ACM interface (covers native
    // USB nRF52840 / ESP32-S3 companions not in the built-in table).
    private fun probe(device: UsbDevice): UsbSerialDriver? {
        UsbSerialProber.getDefaultProber().probeDevice(device)?.let { return it }
        for (i in 0 until device.interfaceCount) {
            val cls = device.getInterface(i).interfaceClass
            if (cls == UsbConstants.USB_CLASS_COMM || cls == UsbConstants.USB_CLASS_CDC_DATA) {
                return CdcAcmSerialDriver(device)
            }
        }
        return null
    }

    fun availableDrivers(): List<UsbSerialDriver> {
        val out = ArrayList<UsbSerialDriver>()
        for (device in usbManager.deviceList.values) {
            val d = probe(device) ?: continue
            knownDrivers[portIdFor(device)] = d
            out.add(d)
        }
        return out
    }

    fun deviceLabel(device: UsbDevice): String {
        val name = try { device.productName } catch (_: Exception) { null }
        if (!name.isNullOrBlank()) return name
        return "USB %04X:%04X".format(device.vendorId, device.productId)
    }

    private fun portInfo(device: UsbDevice): JSONObject =
        JSONObject()
            .put("portId", portIdFor(device))
            .put("usbVendorId", device.vendorId)
            .put("usbProductId", device.productId)
            .put("name", deviceLabel(device))

    // ---- getPorts: previously-authorised, currently-attached devices --------

    fun getGrantedPorts(reqId: String) {
        val arr = JSONArray()
        for (driver in availableDrivers()) {
            if (usbManager.hasPermission(driver.device)) arr.put(portInfo(driver.device))
        }
        js.resolve(reqId, true, arr.toString())
    }

    // ---- requestPort: USB permission prompt, then resolve -------------------

    fun requestPermission(reqId: String, driver: UsbSerialDriver) {
        val device = driver.device
        knownDrivers[portIdFor(device)] = driver
        if (usbManager.hasPermission(device)) {
            js.resolve(reqId, true, portInfo(device).toString())
            return
        }
        ensureReceiver()
        permReqId = reqId
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_USB_PERMISSION).setPackage(context.packageName), flags
        )
        usbManager.requestPermission(device, pi)
    }

    private fun ensureReceiver() {
        if (receiverRegistered) return
        receiverRegistered = true
        val filter = IntentFilter(ACTION_USB_PERMISSION).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
    }

    @Suppress("DEPRECATION")
    private fun usbDeviceFrom(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33)
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    val reqId = permReqId ?: return
                    permReqId = null
                    val device = usbDeviceFrom(intent)
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted && device != null) {
                        js.resolve(reqId, true, portInfo(device).toString())
                    } else {
                        // Matches the web app: user denial = NotFoundError.
                        js.resolve(reqId, false, errJson(BridgeError.NOT_FOUND, "USB permission denied"))
                    }
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val device = usbDeviceFrom(intent) ?: return
                    if (portIdFor(device) == openPortId) main.post { handleDisconnect(portIdFor(device)) }
                }
            }
        }
    }

    // ---- open / close / write ----------------------------------------------

    fun open(reqId: String, portId: String, baudRate: Int) {
        ioExecutor.execute {
            closeInternal()
            val driver = knownDrivers[portId] ?: availableDrivers().firstOrNull { portIdFor(it.device) == portId }
            if (driver == null) {
                js.resolve(reqId, false, errJson(BridgeError.NOT_FOUND, "USB device no longer attached"))
                return@execute
            }
            val device = driver.device
            if (!usbManager.hasPermission(device)) {
                js.resolve(reqId, false, errJson(BridgeError.SECURITY, "USB permission not granted"))
                return@execute
            }
            val connection = usbManager.openDevice(device)
            if (connection == null) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "Could not open USB device"))
                return@execute
            }
            val p = driver.ports.firstOrNull()
            if (p == null) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "USB device has no serial port"))
                return@execute
            }
            try {
                p.open(connection)
                p.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                // Assert DTR/RTS — most CDC/USB-serial companions need DTR high
                // before they will talk. Unsupported on some drivers; ignore.
                try { p.setDTR(true) } catch (_: Exception) {}
                try { p.setRTS(true) } catch (_: Exception) {}
            } catch (e: Exception) {
                try { p.close() } catch (_: Exception) {}
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "Open failed: ${e.message}"))
                return@execute
            }

            port = p
            openPortId = portId
            val io = SerialInputOutputManager(p, object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    if (data.isNotEmpty()) js.serialData(portId, Base64.encodeToString(data, Base64.NO_WRAP))
                }
                override fun onRunError(e: Exception) {
                    main.post { handleDisconnect(portId) }
                }
            })
            ioManager = io
            io.start()
            js.resolve(reqId, true, null)
        }
    }

    fun write(reqId: String, portId: String, base64: String) {
        ioExecutor.execute {
            val p = port
            if (p == null || portId != openPortId) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "Serial port not open"))
                return@execute
            }
            try {
                p.write(Base64.decode(base64, Base64.DEFAULT), WRITE_TIMEOUT_MS)
                js.resolve(reqId, true, null)
            } catch (e: Exception) {
                js.resolve(reqId, false, errJson(BridgeError.NETWORK, "Write failed: ${e.message}"))
            }
        }
    }

    fun close(portId: String) {
        if (portId == openPortId) ioExecutor.execute { closeInternal() }
    }

    private fun closeInternal() {
        // A late onRunError after stop() is harmless — handleDisconnect() guards
        // on openPortId, which we clear here.
        try { ioManager?.stop() } catch (_: Exception) {}
        ioManager = null
        try { port?.close() } catch (_: Exception) {}
        port = null
        openPortId = null
    }

    private fun handleDisconnect(portId: String) {
        if (portId != openPortId) return
        closeInternal()
        js.serialDisconnected(portId)
    }

    companion object {
        private const val ACTION_USB_PERMISSION = "cz.kyblsoft.meshcore.USB_PERMISSION"
        private const val WRITE_TIMEOUT_MS = 2000
    }
}
