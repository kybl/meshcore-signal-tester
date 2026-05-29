package cz.kyblsoft.meshcore

import android.content.ContentValues
import android.content.Context
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
 * Handles CSV save to the public Downloads folder.
 */
class FilesBridge(private val context: Context) {

    @JavascriptInterface
    fun saveCsv(filename: String, content: String) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, "text/csv")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw Exception("MediaStore insert returned null")
                resolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                dir.mkdirs()
                FileOutputStream(File(dir, filename)).use { it.write(content.toByteArray(Charsets.UTF_8)) }
            }
            Handler(Looper.getMainLooper()).post {
                Toast.makeText(context, "Uloženo do Stažených: $filename", Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Handler(Looper.getMainLooper()).post {
                Toast.makeText(context, "Uložení selhalo: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
