package cz.kyblsoft.meshcore.signaltester

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Single source of truth for the runtime-permission matrix. The activity (which
 * requests permissions) and the foreground service (which decides whether it may
 * stream GPS) must agree on these definitions, so they live here instead of being
 * copied into each.
 */
object Permissions {

    fun hasLocation(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * Runtime permissions required to start a capture session. BLE adds the
     * Android 12+ scan/connect permissions; notifications are needed on 13+.
     *
     * Location is requested when the app geotags packets with the phone's GPS
     * ([includePhoneLocation] — the "Packet position from" map setting). It is
     * ALSO required on Android 11 and below for any BLE scan, whatever the
     * position source; on 12+ the manifest's neverForLocation flag on
     * BLUETOOTH_SCAN lifts that coupling.
     */
    fun connectPermissions(includeBluetooth: Boolean, includePhoneLocation: Boolean): List<String> {
        val needed = mutableListOf<String>()
        if (includePhoneLocation || (includeBluetooth && Build.VERSION.SDK_INT < 31)) {
            needed += Manifest.permission.ACCESS_FINE_LOCATION
            needed += Manifest.permission.ACCESS_COARSE_LOCATION
        }
        if (includeBluetooth && Build.VERSION.SDK_INT >= 31) {
            needed += Manifest.permission.BLUETOOTH_SCAN
            needed += Manifest.permission.BLUETOOTH_CONNECT
        }
        if (Build.VERSION.SDK_INT >= 33) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        return needed
    }
}
