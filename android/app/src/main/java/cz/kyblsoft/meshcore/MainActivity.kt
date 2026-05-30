package cz.kyblsoft.meshcore

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    lateinit var ble: BleManager
        private set
    lateinit var location: LocationHelper
        private set

    private lateinit var webView: WebView
    private lateinit var jsApi: JsApi

    val main = Handler(Looper.getMainLooper())

    companion object {
        // Each warning is shown at most once per process lifetime.
        private var batteryCheckShown = false
        private var bgLocationCheckShown = false
    }

    // ---- scanning state (one picker at a time) ----
    private var scanCallback: ScanCallback? = null
    private var pickerDialog: AlertDialog? = null
    private var pickerResolved = false
    private val foundAddrs = ArrayList<String>()
    private val foundNames = ArrayList<String>()

    private var _onPermsGranted: (() -> Unit)? = null

    private val requestPerms = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        MeshcoreService.start(this)
        _onPermsGranted?.invoke()
        _onPermsGranted = null
    }

    private val requestBackgroundLocation = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* user decides in settings; capture still works while screen is on */ }

    // File picker for CSV import — result wired to the pending WebView callback
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val openFileLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        val cb = fileChooserCallback
        fileChooserCallback = null
        cb?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
    }

    // File picker for CSV export — shows "Save as" dialog via SAF
    private var pendingCsvContent: String? = null
    private val saveCsvLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("text/csv")
    ) { uri: Uri? ->
        val content = pendingCsvContent ?: return@registerForActivityResult
        pendingCsvContent = null
        if (uri == null) return@registerForActivityResult
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
        } catch (e: Exception) {
            Toast.makeText(this, "Save failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    fun launchCsvSavePicker(filename: String, content: String) {
        pendingCsvContent = content
        saveCsvLauncher.launch(filename)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        jsApi = JsApi(webView)
        ble = BleManager(applicationContext, jsApi)
        location = LocationHelper(applicationContext, jsApi)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }

        webView.addJavascriptInterface(BleBridge(this), "AndroidBle")
        webView.addJavascriptInterface(GeoBridge(this), "AndroidGeo")
        webView.addJavascriptInterface(FilesBridge(this), "AndroidFiles")
        webView.addJavascriptInterface(ScreenBridge(this), "AndroidScreen")

        // Serve bundled assets from a secure origin so remote map tiles load
        // into WebGL correctly (a real Origin header is sent).
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                // Open any external link in the system browser.
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (e: Exception) {
                    false
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.d("MeshWeb", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }

            // Auto-grant WebView's built-in geolocation permission. This is a
            // belt-and-suspenders fallback in case the JS-level polyfill that
            // replaces navigator.geolocation fails for any reason. The real
            // location work happens in LocationHelper via the native bridge.
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                callback.invoke(origin, true, false)
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                // Cancel any previous pending callback to avoid leaking it.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                openFileLauncher.launch(arrayOf("text/csv", "text/comma-separated-values", "text/*"))
                return true
            }
        }

        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })

        // Permissions are requested lazily at BLE connect time.
    }

    override fun onDestroy() {
        stopScan()
        location.stop()
        MeshcoreService.stop(this)
        webView.destroy()
        super.onDestroy()
    }

    // ---- permission gate (called at connect/scan time) ------------------

    fun ensureConnectPermissions(onGranted: () -> Unit) {
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 31) {
            needed += Manifest.permission.BLUETOOTH_SCAN
            needed += Manifest.permission.BLUETOOTH_CONNECT
        }
        if (Build.VERSION.SDK_INT >= 33) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            MeshcoreService.start(this)
            onGranted()
        } else {
            _onPermsGranted = onGranted
            requestPerms.launch(missing.toTypedArray())
        }
    }

    // ---- device picker (called from BleBridge) --------------------------

    fun requestDevice(reqId: String, filtersJson: String) {
        val prefixes = parsePrefixes(filtersJson)
        main.post { ensureConnectPermissions { startScanDialog(reqId, prefixes) } }
    }

    @SuppressLint("MissingPermission")
    private fun startScanDialog(reqId: String, prefixes: List<String>) {
        if (Build.VERSION.SDK_INT >= 31 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
            != PackageManager.PERMISSION_GRANTED
        ) {
            jsApi.resolve(reqId, false, errJson("SecurityError", "Bluetooth scan permission not granted"))
            return
        }

        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (adapter == null || !adapter.isEnabled) {
            Toast.makeText(this, "Please turn on Bluetooth", Toast.LENGTH_LONG).show()
            jsApi.resolve(reqId, false, errJson("NotFoundError", "Bluetooth is off"))
            return
        }
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            jsApi.resolve(reqId, false, errJson("NotFoundError", "BLE scanner unavailable"))
            return
        }

        pickerResolved = false
        foundAddrs.clear()
        foundNames.clear()

        val listAdapter = ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, ArrayList())

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val name = result.scanRecord?.deviceName
                    ?: try { result.device.name } catch (e: Exception) { null }
                    ?: return
                if (prefixes.isNotEmpty() && prefixes.none { name.startsWith(it, ignoreCase = true) }) return
                val addr = result.device.address
                if (foundAddrs.contains(addr)) return
                foundAddrs.add(addr)
                foundNames.add(name)
                main.post {
                    listAdapter.add("$name\n$addr")
                    listAdapter.notifyDataSetChanged()
                }
            }
        }
        scanCallback = callback

        scanner.startScan(
            null,
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            callback
        )
        // Stop scanning after 20 s to save battery; the dialog stays open.
        main.postDelayed({ stopScan() }, 20_000)

        pickerDialog = AlertDialog.Builder(this)
            .setTitle("Select MeshCore device")
            .setAdapter(listAdapter) { _, which ->
                if (which in foundAddrs.indices) {
                    resolvePicker(reqId, foundAddrs[which], foundNames[which])
                }
            }
            .setNegativeButton("Cancel") { _, _ -> cancelPicker(reqId) }
            .setOnCancelListener { cancelPicker(reqId) }
            .create()
        pickerDialog?.show()
    }

    private fun resolvePicker(reqId: String, address: String, name: String) {
        if (pickerResolved) return
        pickerResolved = true
        stopScan()
        saveKnownDevice(address, name)
        val info = JSONObject().put("id", address).put("name", name)
        jsApi.resolve(reqId, true, info.toString())
        pickerDialog?.dismiss()
        pickerDialog = null
    }

    private fun cancelPicker(reqId: String) {
        if (pickerResolved) return
        pickerResolved = true
        stopScan()
        // Matches the web app's expectation: user cancellation = NotFoundError.
        jsApi.resolve(reqId, false, errJson("NotFoundError", "User cancelled device selection"))
        pickerDialog = null
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        val cb = scanCallback ?: return
        scanCallback = null
        try {
            val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
            adapter?.bluetoothLeScanner?.stopScan(cb)
        } catch (_: Exception) {}
    }

    // ---- known devices (for one-tap reconnect via getDevices) -----------

    fun getKnownDevices(reqId: String) {
        jsApi.resolve(reqId, true, loadKnown().toString())
    }

    private fun prefs() = getSharedPreferences("mc_prefs", Context.MODE_PRIVATE)

    private fun loadKnown(): JSONArray =
        try { JSONArray(prefs().getString("known", "[]")) } catch (e: Exception) { JSONArray() }

    private fun saveKnownDevice(address: String, name: String) {
        val arr = loadKnown()
        for (i in 0 until arr.length()) {
            if (arr.getJSONObject(i).optString("id") == address) return
        }
        arr.put(JSONObject().put("id", address).put("name", name))
        prefs().edit().putString("known", arr.toString()).apply()
    }

    // ---- battery optimization check ------------------------------------

    fun checkBatteryOptimization() {
        main.post {
            if (batteryCheckShown) return@post
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(packageName)) return@post
            batteryCheckShown = true
            AlertDialog.Builder(this)
                .setTitle("Allow unrestricted background use")
                .setMessage(
                    "Battery optimization is active for this app. " +
                    "Android may suspend signal capture when the screen turns off — " +
                    "which defeats the main purpose of the app.\n\n" +
                    "Tap \"Open Settings\" and allow the app to run unrestricted in the background."
                )
                .setPositiveButton("Open Settings") { _, _ ->
                    try {
                        startActivity(Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:$packageName")
                        ))
                    } catch (_: Exception) {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    }
                }
                .setNegativeButton("Later", null)
                .show()
        }
    }

    fun checkBackgroundLocation() {
        if (Build.VERSION.SDK_INT < 29) return
        main.post {
            if (bgLocationCheckShown) return@post
            val bgGranted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
            if (bgGranted) return@post
            bgLocationCheckShown = true
            AlertDialog.Builder(this)
                .setTitle("Allow location all the time")
                .setMessage(
                    "To record your GPS position while the screen is off, " +
                    "this app needs the \"Allow all the time\" location permission.\n\n" +
                    "Tap \"Grant Permission\" and choose \"Allow all the time\" in the next screen."
                )
                .setPositiveButton("Grant Permission") { _, _ ->
                    requestBackgroundLocation.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                }
                .setNegativeButton("Later", null)
                .show()
        }
    }

    // ---- helpers --------------------------------------------------------

    private fun parsePrefixes(filtersJson: String): List<String> {
        val out = ArrayList<String>()
        try {
            val filters = JSONObject(filtersJson).optJSONArray("filters") ?: return out
            for (i in 0 until filters.length()) {
                val f = filters.getJSONObject(i)
                f.optString("namePrefix").takeIf { it.isNotEmpty() }?.let { out.add(it) }
                f.optString("name").takeIf { it.isNotEmpty() }?.let { out.add(it) }
            }
        } catch (_: Exception) {}
        return out
    }

    private fun errJson(name: String, message: String): String =
        JSONObject().put("name", name).put("message", message).toString()
}
