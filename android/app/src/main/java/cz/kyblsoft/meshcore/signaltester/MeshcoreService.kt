package cz.kyblsoft.meshcore.signaltester

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Foreground service that keeps the process alive (and the CPU running via a
 * partial wake lock) while the screen is off, so BLE notifications and GPS
 * fixes keep flowing into the WebView. It declares the `location` and
 * `connectedDevice` foreground-service types.
 *
 * It deliberately holds no BLE/GPS state itself — those live in the activity's
 * managers within the same process; the service's job is purely to elevate and
 * sustain that process.
 */
class MeshcoreService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    // Whether the running foreground-service type set already includes
    // `location`. See onStartCommand for why this matters.
    private var fgHasLocation = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        startAsForeground()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "meshcore:capture").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every connect attempt calls start() again — including auto-reconnects
        // running with the screen locked. Re-running the full startForeground
        // type negotiation there used to DOWNGRADE the service: from the
        // background Android 14+ refuses the while-in-use `location` type, the
        // fallback then settled on connectedDevice alone, and background GPS
        // (packet geotagging) silently stopped. So only ever re-assert to ADD
        // location (permission granted after the service started, e.g. a USB
        // session followed by "Enable location"); never drop it. An already-
        // foreground service needs no new startForeground for a repeat
        // startForegroundService call.
        if (!fgHasLocation && Permissions.hasLocation(this)) addLocationType()
        // Not sticky: after the OS kills the process there is no WebView, radio
        // link or GPS to sustain — a restarted service would only hold a wake
        // lock and show a "capturing" notification for nothing.
        return START_NOT_STICKY
    }

    private fun addLocationType() {
        if (Build.VERSION.SDK_INT < 29) { fgHasLocation = true; return }
        try {
            ServiceCompat.startForeground(
                this, NOTIF_ID, buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
            fgHasLocation = true
        } catch (_: Exception) { /* not allowed right now (background) — keep the current types */ }
    }

    override fun onDestroy() {
        running = false
        try { wakeLock?.release() } catch (_: Exception) {}
        wakeLock = null
        super.onDestroy()
    }

    private fun startAsForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT < 29) {
            startForeground(NOTIF_ID, notification)
            fgHasLocation = true   // no service types before Q
            return
        }
        // The service may run for BLE (connectedDevice + location) or for a
        // USB-only connection where Bluetooth/location permissions aren't held.
        // On Android 14+ each declared type must have its prerequisites met, so
        // try the richest type set first and fall back until one is accepted.
        val connected = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        val loc = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        val candidates = if (Permissions.hasLocation(this))
            listOf(connected or loc, connected, loc)
        else
            listOf(connected)
        for (type in candidates) {
            try {
                ServiceCompat.startForeground(this, NOTIF_ID, notification, type)
                fgHasLocation = (type and loc) != 0
                return
            } catch (_: Exception) { /* try the next, less demanding type */ }
        }
        // Last resort: a plain foreground service with no special type.
        try { startForeground(NOTIF_ID, notification) } catch (_: Exception) {}
    }

    private fun buildNotification(): Notification =
        buildNotification(this, statusText ?: getString(R.string.notif_text))

    companion object {
        private const val CHANNEL_ID = "capture"
        private const val NOTIF_ID = 1

        // Latest connection-status line reported by the web app, mirrored into
        // the notification. Volatile so the binder thread that calls
        // updateStatus() and the service both see a consistent value.
        @Volatile private var statusText: String? = null
        @Volatile private var running = false

        fun start(context: Context) {
            val intent = Intent(context, MeshcoreService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MeshcoreService::class.java))
        }

        /** Update the ongoing notification's text to the current connection state. */
        fun updateStatus(context: Context, text: String) {
            statusText = text
            if (!running) return
            try {
                val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                mgr.notify(NOTIF_ID, buildNotification(context, text))
            } catch (_: Exception) {}
        }

        private fun buildNotification(context: Context, text: String): Notification {
            if (Build.VERSION.SDK_INT >= 26) {
                val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.notif_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                )
                mgr.createNotificationChannel(channel)
            }
            val openIntent = PendingIntent.getActivity(
                context, 0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE
            )
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle(context.getString(R.string.notif_title))
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_signal)
                .setOngoing(true)
                .setContentIntent(openIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
        }
    }
}
