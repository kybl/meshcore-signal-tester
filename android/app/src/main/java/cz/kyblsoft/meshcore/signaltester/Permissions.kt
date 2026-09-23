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
     * Permissions WITHOUT which the connection itself cannot work — a denial here
     * fails the connect. For Bluetooth that is the Android 12+ scan/connect pair,
     * or location on Android 11 and below (where any BLE scan needs it; on 12+
     * the manifest's neverForLocation flag on BLUETOOTH_SCAN lifts that
     * coupling). USB and WiFi need nothing.
     */
    fun requiredToConnect(includeBluetooth: Boolean): List<String> {
        if (!includeBluetooth) return emptyList()
        return if (Build.VERSION.SDK_INT >= 31)
            listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else
            listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    }

    /**
     * Permissions that only improve a session and must NEVER block it:
     * notifications (13+; the capture notification) and location while packets
     * are geotagged from the phone GPS ([includePhoneLocation] — the "Packet
     * position from" setting). Declining these still connects; the page shows
     * "no position" and offers "Enable location" instead.
     */
    fun optionalForSession(includePhoneLocation: Boolean): List<String> {
        val out = mutableListOf<String>()
        if (includePhoneLocation) {
            out += Manifest.permission.ACCESS_FINE_LOCATION
            out += Manifest.permission.ACCESS_COARSE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= 33) out += Manifest.permission.POST_NOTIFICATIONS
        return out
    }
}
