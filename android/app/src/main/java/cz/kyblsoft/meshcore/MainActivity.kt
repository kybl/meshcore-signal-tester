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
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.ArrayAdapter
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    lateinit var ble: BleManager
        private set
    lateinit var serial: SerialManager
        private set
    lateinit var wifi: TcpManager
        private set
    lateinit var location: LocationHelper
        private set

    private lateinit var webView: WebView
    private lateinit var jsApi: JsApi

    private val appUrl = "https://appassets.androidplatform.net/assets/www/index.html"

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

    // The map's "Enable location" button. Separate from requestPerms (the
    // connect flow) because enabling the map location must NOT start the
    // foreground service — viewing your own position shouldn't pin a
    // notification; the service starts when you actually connect to a device.
    private var _onLocationPermResult: (() -> Unit)? = null
    private val requestLocationPerm = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        _onLocationPermResult?.invoke()   // runs whether granted or not — location.start() then streams or reports the denial back to JS
        _onLocationPermResult = null
    }

    // HTML5 fullscreen (the 3D map "fullscreen" button). When the page calls
    // Element.requestFullscreen(), the WebView routes it through
    // onShowCustomView; we host that view on top of the window decor.
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

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
    private var pendingCsvName: String? = null
    private val saveCsvLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("text/csv")
    ) { uri: Uri? ->
        val content = pendingCsvContent ?: return@registerForActivityResult
        val suggested = pendingCsvName
        pendingCsvContent = null
        pendingCsvName = null
        if (uri == null) return@registerForActivityResult   // user cancelled the dialog
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
            Toast.makeText(this, "File ${displayNameOf(uri) ?: suggested} saved.", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Save failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    // Hide/show the system bars while an HTML element is in fullscreen.
    private fun setImmersiveFullscreen(on: Boolean) {
        WindowCompat.setDecorFitsSystemWindows(window, !on)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (on) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    fun launchCsvSavePicker(filename: String, content: String) {
        pendingCsvContent = content
        pendingCsvName = filename
        saveCsvLauncher.launch(filename)
    }

    // Best-effort human-readable name for a SAF document Uri (the user may have
    // renamed the file in the dialog), falling back to the last path segment.
    private fun displayNameOf(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            ?: uri.lastPathSegment
    } catch (e: Exception) { uri.lastPathSegment }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        jsApi = JsApi(webView)
        ble = BleManager(applicationContext, jsApi)
        serial = SerialManager(applicationContext, jsApi)
        wifi = TcpManager(jsApi)
        location = LocationHelper(applicationContext, jsApi)

        configureWebView()
        webView.loadUrl(appUrl)
        wireBackHandler()

        // Permissions are requested lazily at BLE connect time.
    }

    // Build (or rebuild) this WebView's settings, JS bridges and clients.
    // Extracted from onCreate so the exact same configuration can be reapplied
    // to a freshly constructed WebView after the renderer process dies — see
    // onRenderProcessGone and recreateWebView.
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }

        webView.addJavascriptInterface(BleBridge(this), "AndroidBle")
        webView.addJavascriptInterface(SerialBridge(this), "AndroidSerial")
        webView.addJavascriptInterface(WifiBridge(this), "AndroidWifi")
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

            // The renderer process was torn down (almost always the OS reclaiming
            // memory while the app was in the background, occasionally a real
            // crash). Returning false here would let the system kill our whole
            // process; instead we claim the event and rebuild the WebView so the
            // user gets the app back instead of a frozen blank screen.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view !== webView) return true
                android.util.Log.w("MeshWeb", "WebView renderer gone (didCrash=${detail.didCrash()}); rebuilding")
                recreateWebView()
                return true
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

            // window.prompt() (used for the WiFi IP:port input) needs an explicit
            // handler in a WebView, otherwise it silently returns null on many
            // devices. Show a simple input dialog.
            override fun onJsPrompt(
                view: WebView?,
                url: String?,
                message: String?,
                defaultValue: String?,
                result: android.webkit.JsPromptResult
            ): Boolean {
                val input = android.widget.EditText(this@MainActivity).apply {
                    setText(defaultValue ?: "")
                    setSingleLine(true)
                }
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton("OK") { _, _ -> result.confirm(input.text.toString()) }
                    .setNegativeButton("Cancel") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            // HTML5 Fullscreen API support. Without these the page's
            // requestFullscreen() silently does nothing in a WebView, so the
            // 3D map "fullscreen" button appeared dead on Android.
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (customView != null) {   // already in fullscreen — refuse the new one
                    callback.onCustomViewHidden()
                    return
                }
                customView = view
                customViewCallback = callback
                (window.decorView as FrameLayout).addView(
                    view,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                // INVISIBLE (not GONE): the custom view covers the WebView, but
                // keeping it laid out preserves its scroll position. GONE drops it
                // from layout (0 height), which resets the page scroll to the top.
                webView.visibility = View.INVISIBLE
                setImmersiveFullscreen(true)
            }

            override fun onHideCustomView() {
                val view = customView ?: return
                (window.decorView as FrameLayout).removeView(view)
                customView = null
                webView.visibility = View.VISIBLE
                setImmersiveFullscreen(false)
                // The page scroll is restored on the JS side (fullscreenchange),
                // since the document scroll lives in Blink, not webView.scrollY.
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
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
    }

    // Registered once from onCreate. The callback reads the current webView
    // field each time it fires, so it keeps working after a WebView rebuild.
    private fun wireBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Leave HTML5 fullscreen first if the map is maximised. Asking the
                // page to exit keeps document.fullscreenElement in sync and fires
                // onHideCustomView to tear down our overlay.
                if (customView != null) {
                    webView.evaluateJavascript(
                        "document.exitFullscreen && document.exitFullscreen()", null
                    )
                    return
                }
                // Let the web app close an open overlay (help / settings) first;
                // only leave the app when nothing was open to dismiss.
                webView.evaluateJavascript(
                    "(typeof window.__mcHandleBack==='function' && window.__mcHandleBack())===true"
                ) { result ->
                    if (result == "true") return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
                }
            }
        })
    }

    // Replace a dead WebView with a fresh one and reload the app. Called when
    // the renderer process is gone (see onRenderProcessGone). The page starts
    // over — in-memory capture from before the crash is lost — but the UI
    // recovers instead of staying stuck on a blank screen. The managers keep
    // their JsApi reference; only its target WebView is rebound.
    private fun recreateWebView() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        // Drop any lingering HTML5-fullscreen overlay left over from the old page.
        customView?.let { (window.decorView as FrameLayout).removeView(it) }
        customView = null
        customViewCallback = null

        webView = WebView(this)
        setContentView(webView)
        jsApi.rebind(webView)
        configureWebView()
        // ?recover=1 tells the page this is a crash rebuild (not a fresh launch),
        // so it resumes the just-crashed session's data instead of starting clean.
        webView.loadUrl("$appUrl?recover=1")
    }

    override fun onDestroy() {
        stopScan()
        location.stop()
        MeshcoreService.stop(this)
        webView.destroy()
        super.onDestroy()
    }

    // ---- permission gate (called at connect/scan time) ------------------

    fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    // Location-only permission request for the map's "Enable location" button.
    // Deliberately does not start the foreground service (see requestLocationPerm).
    fun ensureLocationPermission(onResult: () -> Unit) {
        if (hasLocationPermission()) { onResult(); return }
        _onLocationPermResult = onResult
        requestLocationPerm.launch(arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ))
    }

    fun ensureConnectPermissions(includeBluetooth: Boolean = true, onGranted: () -> Unit) {
        val needed = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (includeBluetooth && Build.VERSION.SDK_INT >= 31) {
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

    // ---- USB serial picker (called from SerialBridge) -------------------

    fun requestSerialPort(reqId: String) {
        val drivers = serial.availableDrivers()
        if (drivers.isEmpty()) {
            Toast.makeText(
                this,
                "No USB serial device found. Plug in your device and tap Connect USB again.",
                Toast.LENGTH_LONG
            ).show()
            jsApi.resolve(reqId, false, errJson("NotFoundError", "No USB serial devices found"))
            return
        }
        // A single device goes straight to the system USB permission prompt;
        // multiple devices get a chooser first.
        if (drivers.size == 1) {
            serial.requestPermission(reqId, drivers[0])
            return
        }
        val labels = drivers.map { serial.deviceLabel(it.device) }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Select USB device")
            .setItems(labels) { _, which -> serial.requestPermission(reqId, drivers[which]) }
            .setNegativeButton("Cancel") { _, _ ->
                jsApi.resolve(reqId, false, errJson("NotFoundError", "User cancelled device selection"))
            }
            .setOnCancelListener {
                jsApi.resolve(reqId, false, errJson("NotFoundError", "User cancelled device selection"))
            }
            .show()
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
