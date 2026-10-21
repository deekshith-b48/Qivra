package com.superbrain.mobile

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Qivra share target (ACTION_SEND / ACTION_SEND_MULTIPLE).
 *
 * Shared text is written as-is; shared files are copied from their content://
 * URIs into app-private storage (files/share_inbox/files) with random names and
 * a size cap, while this activity still holds the temporary read grant. A JSON
 * envelope is then written atomically to files/share_inbox and MainActivity is
 * opened with qivra://share. The JS side validates and ingests the envelope, so
 * a share is persisted even if the app is killed before JS runs.
 * Only content:// URIs are accepted (no file:// paths from other apps).
 */
class ShareActivity : Activity() {
    private val maxBytes = 200L * 1024 * 1024
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val action = intent?.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
            finish()
            return
        }
        Toast.makeText(this, "Saving to Qivra…", Toast.LENGTH_SHORT).show()
        val snapshot = Intent(intent)
        executor.execute {
            val ok = try {
                writeEnvelope(snapshot)
                true
            } catch (e: Exception) {
                false
            }
            runOnUiThread {
                if (ok) {
                    val open = Intent(Intent.ACTION_VIEW, Uri.parse("qivra://share")).apply {
                        setClassName(this@ShareActivity, "com.superbrain.mobile.MainActivity")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    }
                    startActivity(open)
                } else {
                    Toast.makeText(this, "Qivra could not save this share.", Toast.LENGTH_LONG).show()
                }
                finish()
            }
        }
    }

    private fun writeEnvelope(src: Intent) {
        val inbox = File(filesDir, "share_inbox").apply { mkdirs() }
        val filesOut = File(inbox, "files").apply { mkdirs() }
        val id = UUID.randomUUID().toString()
        val env = JSONObject()
        env.put("version", 1)
        env.put("id", id)
        env.put("action", if (src.action == Intent.ACTION_SEND_MULTIPLE) "SEND_MULTIPLE" else "SEND")
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        env.put("receivedAt", iso.format(Date()))
        src.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.take(200_000)?.let { env.put("text", it) }
        src.getStringExtra(Intent.EXTRA_SUBJECT)?.take(500)?.let { env.put("subject", it) }

        val files = JSONArray()
        val errors = JSONArray()
        for (uri in streams(src)) {
            val name = displayName(uri)
            if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
                errors.put(JSONObject().put("name", name).put("reason", "Only content shared by apps can be imported."))
                continue
            }
            val mime = (contentResolver.getType(uri) ?: src.type ?: "application/octet-stream").lowercase(Locale.US)
            val ext = name.substringAfterLast('.', "").lowercase(Locale.US).filter { it.isLetterOrDigit() }.take(5).ifEmpty { "bin" }
            val out = File(filesOut, "${UUID.randomUUID()}.$ext")
            try {
                var total = 0L
                var tooBig = false
                contentResolver.openInputStream(uri)?.use { input ->
                    out.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > maxBytes) { tooBig = true; break }
                            output.write(buf, 0, n)
                        }
                    }
                } ?: throw IllegalStateException("unreadable")
                if (tooBig) {
                    out.delete()
                    errors.put(JSONObject().put("name", name).put("reason", "File is larger than 200 MB."))
                } else {
                    files.put(JSONObject().put("path", out.absolutePath).put("name", name).put("mime", mime).put("size", total))
                }
            } catch (e: Exception) {
                out.delete()
                errors.put(JSONObject().put("name", name).put("reason", "The file could not be read."))
            }
        }
        env.put("files", files)
        env.put("errors", errors)
        val tmp = File(inbox, "$id.tmp")
        tmp.writeText(env.toString())
        if (!tmp.renameTo(File(inbox, "$id.json"))) throw IllegalStateException("rename failed")
    }

    @Suppress("DEPRECATION")
    private fun streams(src: Intent): List<Uri> {
        if (src.action == Intent.ACTION_SEND_MULTIPLE) {
            val list = if (Build.VERSION.SDK_INT >= 33) src.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                       else src.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            return list?.take(20) ?: emptyList()
        }
        val one = if (Build.VERSION.SDK_INT >= 33) src.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                  else src.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        return listOfNotNull(one)
    }

    private fun displayName(uri: Uri): String {
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getString(0)
                    if (!n.isNullOrBlank()) return n.substringAfterLast('/').take(120)
                }
            }
        } catch (_: Exception) {}
        return (uri.lastPathSegment ?: "file").substringAfterLast('/').take(120)
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }
}
