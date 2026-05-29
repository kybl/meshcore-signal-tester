# Keep the JavaScript-interface classes intact — their methods are called by
# name from the WebView and must not be renamed or stripped.
-keepclassmembers class cz.kyblsoft.meshcore.** {
    @android.webkit.JavascriptInterface <methods>;
}
