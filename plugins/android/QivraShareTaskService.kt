package __PACKAGE__

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import org.json.JSONObject
import java.io.File

/**
 * Runs the "QivraShare" headless JS task (src/services/shareTask.ts) after a
 * share, so the user stays in the app they shared from.
 *
 *  - Short foreground service ("Preparing transcript and summary…"): Android
 *    freezes and stops plain background services within seconds.
 *  - The JS task finishes by writing files/share_task/result-*.json. This service
 *    posts one notification per item (tap → qivra://item/<id>) and stops when every
 *    started task has answered. (React Native's own task-finished callback does not
 *    reach headless services under the New Architecture; its 170 s timeout remains
 *    the backstop.)
 *
 * Started only by ShareActivity while it is visible; not exported.
 */
class QivraShareTaskService : HeadlessJsTaskService() {
    private val handler = Handler(Looper.getMainLooper())
    private var pending = 0
    private var polling = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        pending++
        if (!polling) {
            polling = true
            handler.postDelayed(poll, POLL_MS)
        }
        return super.onStartCommand(intent, flags, startId)
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
        HeadlessJsTaskConfig("QivraShare", Arguments.createMap(), 170_000L, true)

    private val poll = object : Runnable {
        override fun run() {
            val results = File(filesDir, "share_task").listFiles { f -> f.name.startsWith("result-") && f.name.endsWith(".json") }.orEmpty()
            for (f in results.sortedBy { it.name }) {
                try {
                    postNotes(JSONObject(f.readText()))
                } catch (e: Exception) {
                    // Malformed result: drop it; the items are still in the app.
                }
                f.delete()
                pending--
            }
            if (pending <= 0) {
                polling = false
                stopSelf()
            } else {
                handler.postDelayed(this, POLL_MS)
            }
        }
    }

    private fun canNotify(): Boolean =
        Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun postNotes(result: JSONObject) {
        if (!canNotify()) return
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(READY_CHANNEL) == null) {
            val ch = NotificationChannel(READY_CHANNEL, "Saved items ready", NotificationManager.IMPORTANCE_DEFAULT)
            ch.description = "When a shared video, post or page has its transcript and summary."
            ch.lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            nm.createNotificationChannel(ch)
        }
        val notes = result.optJSONArray("notes") ?: return
        for (i in 0 until minOf(notes.length(), 20)) {
            val n = notes.optJSONObject(i) ?: continue
            val itemId = n.optString("itemId")
            if (!ITEM_ID.matches(itemId)) continue
            val open = Intent(Intent.ACTION_VIEW, Uri.parse("qivra://item/$itemId")).apply {
                setClassName(this@QivraShareTaskService, "__PACKAGE__.MainActivity")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val pi = PendingIntent.getActivity(this, itemId.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val body = n.optString("body").take(300)
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, READY_CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
            val notification = builder
                .setSmallIcon(R.drawable.notification_icon)
                .setContentTitle(n.optString("title").take(120))
                .setContentText(body)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            nm.notify("qivra-item", itemId.hashCode(), notification)
        }
    }

    private fun startAsForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(PROCESSING_CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(PROCESSING_CHANNEL, "Preparing saved items", NotificationManager.IMPORTANCE_LOW))
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, PROCESSING_CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val notification = builder
            .setSmallIcon(R.drawable.notification_icon)
            .setContentTitle("Qivra")
            .setContentText("Preparing transcript and summary…")
            .setProgress(0, 0, true)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(FOREGROUND_ID, notification)
        } catch (e: Exception) {
            // Not allowed to go foreground (unexpected here): keep running as a plain service.
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        super.onDestroy()
    }

    companion object {
        private const val FOREGROUND_ID = 7341
        private const val POLL_MS = 1_000L
        private const val PROCESSING_CHANNEL = "qivra-processing"
        private const val READY_CHANNEL = "qivra-ready"
        private val ITEM_ID = Regex("^[A-Za-z0-9_-]{1,80}$")
    }
}
