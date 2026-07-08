package cz.kyblsoft.meshcore.signaltester

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File
import java.io.FileOutputStream

/**
 * JavaScript interface exposed as `window.AndroidFiles`.
 * Handles CSV save — either via SAF "Save as" dialog or directly to Downloads.
 */
class FilesBridge(private val activity: MainActivity) {

    private val main = Handler(Looper.getMainLooper())

    /** Show a native "Save as" dialog (Storage Access Framework). */
    @JavascriptInterface
    fun saveCsvWithPicker(filename: String, content: String) {
        main.post { activity.launchCsvSavePicker(filename, content) }
    }

    /** Save directly to the public Downloads folder (legacy fallback). */
    @JavascriptInterface
    fun saveCsv(filename: String, content: String) {
        try {
            // Encode once and reuse for both the write and the reported size.
            val bytes = content.toByteArray(Charsets.UTF_8)
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, "text/csv")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = activity.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw Exception("MediaStore insert returned null")
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                dir.mkdirs()
                FileOutputStream(File(dir, filename)).use { it.write(bytes) }
            }
            main.post {
                Toast.makeText(activity, "Saved to Downloads: $filename (${formatBytesSI(bytes.size)})", Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            main.post {
                Toast.makeText(activity, "Save failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
