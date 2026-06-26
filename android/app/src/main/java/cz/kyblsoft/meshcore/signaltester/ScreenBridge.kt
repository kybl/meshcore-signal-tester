package cz.kyblsoft.meshcore.signaltester

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
