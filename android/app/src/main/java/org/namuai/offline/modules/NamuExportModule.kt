package org.namuai.offline.modules

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.namuai.offline.BuildConfig
import org.namuai.offline.R
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.export.ExportLabels
import org.namuai.offline.core.export.ExportStore
import org.namuai.offline.core.export.Exporter
import org.namuai.offline.core.util.SystemClock
import org.namuai.offline.export.AndroidReadOnlyDb
import org.namuai.offline.platform.ChatDataDirectory
import org.namuai.offline.specs.NativeNamuExportSpec
import org.namuai.offline.transfer.StatFsSpaceProbe
import java.io.File
import java.util.concurrent.Executors

/**
 * Streaming text export and share sheet (SEC-004, SEC-005, contract §7).
 * Formatting, paging, ZIP/index.json, snapshot strategy and the 24 h sweep are
 * namu-core's JVM-tested Exporter/ExportStore; this module adds the SQLite
 * connection, the FileProvider URI and the chooser.
 */
class NamuExportModule(reactContext: ReactApplicationContext) : NativeNamuExportSpec(reactContext) {
    private val executor = Executors.newSingleThreadExecutor()

    private fun store() = ExportStore(exportsDir(reactApplicationContext), SystemClock)

    private fun exporter() = Exporter(
        store(),
        StatFsSpaceProbe(exportsDir(reactApplicationContext)),
        SystemClock,
        BuildConfig.VERSION_NAME,
    )

    override fun invalidate() {
        executor.shutdown()
        super.invalidate()
    }

    /** Only the app's own chat directory is accepted; the path is never echoed back in errors. */
    private fun chatDatabase(dbDirectory: String): File {
        val expected = ChatDataDirectory.directory(reactApplicationContext).canonicalFile
        if (File(dbDirectory).canonicalFile != expected) throw NamuException(ErrorCodes.INVALID_STATE, "unexpected directory")
        val file = File(expected, Exporter.CHAT_DB_FILE_NAME)
        if (!file.isFile) throw NamuException(ErrorCodes.NOT_FOUND, "no chat database")
        return file
    }

    private fun labels(json: String): ExportLabels =
        ExportLabels.parse(json) ?: throw NamuException(ErrorCodes.INVALID_STATE, "labels")

    override fun exportConversation(dbDirectory: String, conversationId: String, labelsJson: String, promise: Promise) =
        executor.resolve(promise) {
            val file = chatDatabase(dbDirectory)
            val parsed = labels(labelsJson)
            AndroidReadOnlyDb(file).use { db -> exporter().exportConversation(db, file, conversationId, parsed) }
        }

    override fun exportAllConversations(dbDirectory: String, labelsJson: String, promise: Promise) =
        executor.resolve(promise) {
            val file = chatDatabase(dbDirectory)
            val parsed = labels(labelsJson)
            AndroidReadOnlyDb(file).use { db -> exporter().exportAll(db, file, parsed) }
        }

    /**
     * Presents the chooser only for a COMPLETE export. Android reports neither completion nor
     * cancellation of a share, so this resolves `true` once the chooser was launched and `false`
     * when nothing could be launched. The file stays until JS calls deleteExport or the 24 h
     * sweep removes it (SEC-005).
     */
    override fun share(exportId: String, promise: Promise) = executor.resolve(promise) {
        val context = reactApplicationContext
        val file = store().fileOf(exportId) ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown export")
        val uri = FileProvider.getUriForFile(context, context.packageName + ".exports", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = if (file.name.endsWith(".zip")) "application/zip" else "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("", uri) // carries the read grant to the chosen target
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, context.getString(R.string.namu_export_share_title)).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val activity = context.currentActivity
        try {
            if (activity != null) {
                activity.startActivity(chooser)
            } else {
                context.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        } catch (e: ActivityNotFoundException) {
            false
        } catch (e: SecurityException) {
            false
        }
    }

    override fun deleteExport(exportId: String, promise: Promise) = executor.resolve(promise) { store().delete(exportId) }

    override fun sweepExports(promise: Promise) = executor.resolve(promise) { store().sweep().toDouble() }

    override fun deleteAllExports(promise: Promise) = executor.resolve(promise) { store().deleteAll() }

    companion object {
        /** Contract §7: cacheDir/namu-exports, the single FileProvider path. */
        fun exportsDir(context: Context): File = File(context.applicationContext.cacheDir, "namu-exports")

        /** SEC-005: called on every process start, with or without a JS runtime. */
        fun sweepOnStart(context: Context) {
            val appContext = context.applicationContext
            Thread({
                try {
                    ExportStore(exportsDir(appContext), SystemClock).sweep()
                } catch (e: Exception) {
                    // Swept again at the next start.
                }
            }, "namu-export-sweep").start()
        }
    }
}
