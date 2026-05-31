# Keep the JavaScript-interface classes intact — their methods are called by
# name from the WebView and must not be renamed or stripped.
-keepclassmembers class cz.kyblsoft.meshcore.** {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep all app classes intact — the package is small so there is no benefit
# in obfuscating it, and R8 inlining/renaming Kotlin lambdas and @Synchronized
# methods in BleManager breaks the GATT operation queue.
-keep class cz.kyblsoft.meshcore.** { *; }
