package cz.kyblsoft.meshcore

import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.JavascriptInterface

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
}
