package org.namuai.offline

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.namuai.offline.core.transfer.RunOutcome
import org.namuai.offline.transfer.AndroidTransferScheduler
import org.namuai.offline.transfer.TransferRuntime
import org.namuai.offline.transfer.TransferWorker

/**
 * NOT RUN in this repository's bootstrap environment (no Android SDK / device).
 * QA-004 / ARC-003: the native transfer service and its OS entry points work in
 * a process that never created a React instance or a JS runtime. Instrumented
 * tests run inside the app process without launching MainActivity, which is
 * exactly that situation.
 *
 *   ./gradlew :app:connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class BackgroundEntryPointsInstrumentedTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun snapshotIsAnsweredWithoutAJsRuntime() {
        val json = TransferRuntime.get(context).service.snapshotJson()
        assertTrue(json.contains("\"schema\":1"))
        assertTrue(json.contains("\"install\""))
        assertTrue(json.contains("\"network\""))
    }

    @Test
    fun runningAnUnknownTransferIsAHarmlessNoOp() {
        val service = TransferRuntime.get(context).service
        val outcome = service.runTransfer("00000000-0000-4000-8000-000000000000", service.newControl())
        assertTrue(outcome is RunOutcome.NothingToDo)
    }

    @Test
    fun workerEntryPointRunsWithoutReact() {
        val worker = TestListenableWorkerBuilder<TransferWorker>(context)
            .setInputData(
                Data.Builder()
                    .putString(AndroidTransferScheduler.EXTRA_TRANSFER_ID, "00000000-0000-4000-8000-000000000000")
                    .build(),
            )
            .build()
        val result = runBlocking { worker.doWork() }
        assertEquals(ListenableWorker.Result.success(), result)
    }
}
