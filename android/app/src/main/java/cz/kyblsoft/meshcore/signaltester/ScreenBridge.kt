package cz.kyblsoft.meshcore.signaltester

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

class ScreenBridge(private val activity: MainActivity) {

    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun keepOn(enable: Boolean) {
        main.post {
            if (enable) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    /** Match the system-bar icon colour to the web theme. In edge-to-edge the
     *  bars are transparent and the page background shows through, so light
     *  (cream) theme needs dark icons (light=true) and dark theme needs light
     *  icons (light=false). Called from the web app whenever the theme changes. */
    @JavascriptInterface
    fun setLightSystemBars(light: Boolean) {
        main.post {
            WindowInsetsControllerCompat(activity.window, activity.window.decorView).run {
                isAppearanceLightStatusBars = light
                isAppearanceLightNavigationBars = light
            }
        }
    }

    /** Open an external URL (http/https/mailto/tel) in the system handler. */
    @JavascriptInterface
    fun openUrl(url: String) {
        main.post {
            try {
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e: Exception) {
                Toast.makeText(activity, "Can't open: $url", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** Reflect the web app's connection status in the foreground notification. */
    @JavascriptInterface
    fun setStatus(text: String) {
        MeshcoreService.updateStatus(activity.applicationContext, text)
    }

    /** Stop the foreground service (and drop its ongoing notification). The web
     *  app calls this once it has settled into a disconnected state with no
     *  reconnect pending — there's nothing left to keep the process alive for,
     *  and a lingering "Disconnected" notification the user can't dismiss is
     *  just noise. A later connect starts the service again. */
    @JavascriptInterface
    fun stopCapture() {
        MeshcoreService.stop(activity.applicationContext)
    }

    /** The web app's packet-position source. When it geotags packets from the
     *  MeshCore device's own GPS instead of the phone's ("Packet position
     *  from" map setting), the connect flow must not demand the phone's
     *  location permission. Called once at startup and on every change. */
    @JavascriptInterface
    fun setWantsPhoneLocation(wants: Boolean) {
        activity.wantsPhoneLocation = wants
    }

    /** Recent process-death records for this app as a JSON array (API 30+;
     *  "[]" where unsupported or on any failure). Each entry: ts (epoch ms),
     *  process (full process name — the main app or a WebView renderer),
     *  reason (numeric), reasonName, importance (process importance at the
     *  time of death — 125 = foreground service, i.e. capture was running),
     *  status (exit status / signal number) and desc (system's free-text
     *  explanation). The web app merges these into a persistent diagnostics
     *  log so overnight kills can be attributed instead of guessed at. */
    @JavascriptInterface
    fun exitReasons(): String = try {
        if (Build.VERSION.SDK_INT < 30) "[]" else {
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val arr = org.json.JSONArray()
            for (r in am.getHistoricalProcessExitReasons(activity.packageName, 0, 16)) {
                arr.put(JSONObject()
                    .put("ts", r.timestamp)
                    .put("process", r.processName ?: "")
                    .put("reason", r.reason)
                    .put("reasonName", exitReasonName(r.reason))
                    .put("importance", r.importance)
                    .put("status", r.status)
                    .put("desc", r.description ?: ""))
            }
            arr.toString()
        }
    } catch (e: Exception) {
        "[]"
    }

    private fun exitReasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_EXIT_SELF -> "exit-self"
        ApplicationExitInfo.REASON_SIGNALED -> "signaled"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "low-memory"
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native-crash"
        ApplicationExitInfo.REASON_ANR -> "anr"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "init-failure"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission-change"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive-resource-usage"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "user-requested"
        ApplicationExitInfo.REASON_USER_STOPPED -> "user-stopped"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency-died"
        ApplicationExitInfo.REASON_FREEZER -> "freezer"
        ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "package-state-change"
        ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "package-updated"
        ApplicationExitInfo.REASON_OTHER -> "other"
        else -> "unknown"
    }

    /** Native APK version as JSON {"name":"1.2.0","code":3} so the web UI can
     *  show the real installed build (and its versionCode) instead of the web
     *  app's own version constant. */
    @JavascriptInterface
    fun appVersion(): String = try {
        val pi = activity.packageManager.getPackageInfo(activity.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode
                   else @Suppress("DEPRECATION") pi.versionCode.toLong()
        JSONObject().put("name", pi.versionName ?: "").put("code", code).toString()
    } catch (e: Exception) {
        "{}"
    }
}
