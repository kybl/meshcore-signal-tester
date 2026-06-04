package cz.kyblsoft.meshcore

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.widget.Toast

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
}
