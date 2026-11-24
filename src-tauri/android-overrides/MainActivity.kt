package com.d.pdf_reader

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.content.ContentValues
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

// NOTE: this file is the tracked source of truth. `scripts/build.mjs` copies it
// over the (git-ignored) generated Android project before every Android build.
class MainActivity : TauriActivity() {
  // The document another app asked us to open (VIEW / SEND intent), waiting for
  // the web UI to pick it up through the `AndroidIntent` JS bridge.
  @Volatile private var pendingDocument: String? = null
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    captureDocument(intent)

    // Hide the bottom nav bar (immersive) but keep the status bar, since the
    // toolbar's top gradient is designed to sit under it. A swipe from the
    // bottom edge still brings the nav bar back temporarily.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val insetsController = WindowInsetsControllerCompat(window, window.decorView)
    insetsController.hide(WindowInsetsCompat.Type.navigationBars())
    insetsController.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(this, "AndroidIntent")
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (captureDocument(intent)) {
      // App already running: tell the page there is a new document to open.
      webView?.post {
        webView?.evaluateJavascript(
          "window.dispatchEvent(new Event('android-open-document'))", null)
      }
    }
  }

  /** Returns the pending document as JSON {"uri": ..., "name": ...} once, or null. */
  @JavascriptInterface
  fun consumeDocument(): String? {
    val doc = pendingDocument
    pendingDocument = null
    return doc
  }

  /**
   * "Save as copy" on Android: copies a staged file (written by the Rust side
   * into the app cache) into the public Downloads folder through MediaStore,
   * which needs no storage permission. Returns the saved file name, or null.
   */
  @JavascriptInterface
  fun saveToDownloads(stagedPath: String, displayName: String): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    return try {
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, displayName)
        put(MediaStore.Downloads.MIME_TYPE, "application/pdf")
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      }
      val target = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: return null
      File(stagedPath).inputStream().use { input ->
        contentResolver.openOutputStream(target)?.use { output -> input.copyTo(output) }
          ?: return null
      }
      File(stagedPath).delete()
      // The system may rename on a clash; report the final name.
      contentResolver.query(target, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)
        ?.use { if (it.moveToFirst()) it.getString(0) else displayName } ?: displayName
    } catch (_: Exception) {
      null
    }
  }

  /** Reading mode: hide (or restore) the status bar; the nav bar is always hidden. */
  @JavascriptInterface
  fun setReadingMode(on: Boolean) {
    runOnUiThread {
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      if (on) controller.hide(WindowInsetsCompat.Type.statusBars())
      else controller.show(WindowInsetsCompat.Type.statusBars())
    }
  }

  private fun documentUri(intent: Intent): Uri? {
    val action = intent.action
    if (action == Intent.ACTION_VIEW) return intent.data
    if (action == Intent.ACTION_SEND) {
      @Suppress("DEPRECATION")
      val stream: Uri? = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableExtra(Intent.EXTRA_STREAM)
      }
      if (stream != null) return stream
      val clip: ClipData? = intent.clipData
      if (clip != null && clip.itemCount > 0) return clip.getItemAt(0).uri
    }
    return null
  }

  private fun captureDocument(intent: Intent?): Boolean {
    if (intent == null) return false
    val uri = documentUri(intent) ?: return false
    if (uri.scheme != "content" && uri.scheme != "file") return false
    // Best effort: only providers that offer persistable grants allow this.
    // Ask for write access too (it lets "Overwrite original" work); fall back
    // to read-only when the provider does not offer it.
    try {
      contentResolver.takePersistableUriPermission(
        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    } catch (_: Exception) {
      try {
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      } catch (_: Exception) {
      }
    }
    var name: String? = null
    try {
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) name = it.getString(0)
      }
    } catch (_: Exception) {
    }
    pendingDocument = JSONObject().put("uri", uri.toString()).put("name", name ?: JSONObject.NULL).toString()
    return true
  }
}
