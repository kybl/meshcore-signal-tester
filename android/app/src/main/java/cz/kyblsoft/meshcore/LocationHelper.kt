package cz.kyblsoft.meshcore

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper

/**
 * Streams GPS fixes via the framework [LocationManager] (no Google Play
 * Services dependency, works on any device and offline). Fixes are forwarded
 * to JavaScript through [JsApi]. While the foreground service runs, updates
 * keep arriving with the screen off.
 */
@SuppressLint("MissingPermission")
class LocationHelper(context: Context, private val js: JsApi) : LocationListener {

    private val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var active = false

    fun start() {
        if (active) return
        try {
            var any = false
            // Use GPS alone for live updates. Registering GPS *and* NETWORK at the
            // same time interleaves precise GPS fixes with coarse cell/wifi ones
            // (often hundreds of metres off — underpasses, tunnels), which makes
            // the marker jump back and forth. Fall back to NETWORK only when GPS
            // is unavailable, so the two streams are never mixed.
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper())
                any = true
            } else if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 2000L, 0f, this, Looper.getMainLooper())
                any = true
            }
            if (!any) {
                // No provider enabled (location turned off at the OS level). Leave
                // `active` false so a later retry — after the user enables GPS —
                // actually re-requests instead of short-circuiting on `if (active)`.
                js.geoError(2, "No location provider enabled (turn on GPS)")
                return
            }
            active = true
            lastKnown()?.let { emit(it) }
        } catch (e: SecurityException) {
            js.geoError(1, "Location permission denied")
        } catch (e: Exception) {
            js.geoError(2, e.message ?: "Location error")
        }
    }

    fun stop() {
        if (!active) return
        active = false
        try { lm.removeUpdates(this) } catch (_: Exception) {}
    }

    fun current() {
        val last = lastKnown()
        if (last != null) emit(last) else start()
    }

    private fun lastKnown(): Location? = try {
        lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
    } catch (_: Exception) { null }

    private fun emit(l: Location) {
        js.geoUpdate(l.latitude, l.longitude, if (l.hasAccuracy()) l.accuracy.toDouble() else 0.0, l.time)
    }

    override fun onLocationChanged(location: Location) = emit(location)
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
}
