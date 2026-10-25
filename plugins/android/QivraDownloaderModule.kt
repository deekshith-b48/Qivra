package __PACKAGE__

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.util.concurrent.Executors

/**
 * yt-dlp on the phone (youtubedl-android, the engine ytdlnis uses). Qivra uses it only to fetch the audio
 * of a public Instagram reel the user shared, so the reel can be transcribed. No login, no cookies.
 * Called from src/services/downloader.ts.
 */
class QivraDownloaderModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var ready = false

  override fun getName() = "QivraDownloader"

  private fun ensureInit() {
    if (ready) return
    synchronized(this) {
      if (!ready) {
        YoutubeDL.getInstance().init(ctx.applicationContext) // unpacks Python and yt-dlp once
        ready = true
      }
    }
  }

  /** Downloads the best audio-only stream (no ffmpeg needed) into the cache; resolves with yt-dlp's JSON line. */
  @ReactMethod
  fun downloadAudio(url: String, maxMb: Double, promise: Promise) {
    worker.execute {
      try {
        ensureInit()
        val dir = File(ctx.cacheDir, "ytdl").apply { mkdirs() }
        val req = YoutubeDLRequest(url)
        req.addOption("-f", "bestaudio[ext=m4a]/bestaudio/best")
        req.addOption("--no-playlist")
        req.addOption("--max-filesize", "${maxMb.toInt()}M")
        req.addOption("-o", "${dir.absolutePath}/%(id)s.%(ext)s")
        req.addOption("-j") // print the info JSON …
        req.addOption("--no-simulate") // … and still download
        req.addOption("--no-progress")
        req.addOption("--no-mtime")
        promise.resolve(YoutubeDL.getInstance().execute(req).out)
      } catch (e: Throwable) {
        promise.reject("DOWNLOAD_FAILED", e.message ?: "Download failed", e)
      }
    }
  }

  /** Updates yt-dlp from its official releases (sites change; a newer yt-dlp often fixes a broken download). */
  @ReactMethod
  fun update(promise: Promise) {
    worker.execute {
      try {
        ensureInit()
        val status = YoutubeDL.getInstance().updateYoutubeDL(ctx.applicationContext, YoutubeDL.UpdateChannel.STABLE)
        promise.resolve("${status?.name ?: "DONE"} ${YoutubeDL.getInstance().versionName(ctx.applicationContext) ?: ""}".trim())
      } catch (e: Throwable) {
        promise.reject("UPDATE_FAILED", e.message ?: "Update failed", e)
      }
    }
  }

  @ReactMethod
  fun version(promise: Promise) {
    worker.execute {
      try {
        ensureInit()
        promise.resolve(YoutubeDL.getInstance().versionName(ctx.applicationContext))
      } catch (e: Throwable) {
        promise.reject("INIT_FAILED", e.message ?: "yt-dlp could not start", e)
      }
    }
  }
}

class QivraDownloaderPackage : ReactPackage {
  override fun createNativeModules(c: ReactApplicationContext): List<NativeModule> = listOf(QivraDownloaderModule(c))
  override fun createViewManagers(c: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
