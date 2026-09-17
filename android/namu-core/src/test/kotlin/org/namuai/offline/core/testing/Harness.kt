package org.namuai.offline.core.testing

import org.namuai.offline.core.descriptor.TinkEd25519Verifier
import org.namuai.offline.core.store.NioDirectorySyncer
import org.namuai.offline.core.store.StorageLayout
import org.namuai.offline.core.transfer.Journal
import org.namuai.offline.core.transfer.RetryPolicy
import org.namuai.offline.core.transfer.RunOutcome
import org.namuai.offline.core.transfer.ServiceConfig
import org.namuai.offline.core.transfer.TransferEngine
import org.namuai.offline.core.transfer.TransferRecord
import org.namuai.offline.core.transfer.TransferService
import org.namuai.offline.core.util.CrashHook
import java.io.File

/**
 * Wires a complete [TransferService] over a temp directory, the in-process
 * fault server and deterministic fakes. `restart()` models a process death:
 * a new service over the same files and the same (durable) journal.
 */
class Harness(
    val root: File,
    val model: ByteArray = Fixtures.ggufModel(MODEL_BYTES),
    clockAutoAdvanceMs: Long = 0,
) {
    val sha = Fixtures.sha256(model)
    val signer = TestSigner()
    val path = "models/aya-global-q4km/$sha/model.gguf"
    val server = FaultServer(model, path)
    val clock = FakeClock(autoAdvanceMs = clockAutoAdvanceMs)
    val sleeper = RecordingSleeper(clock)
    val network = FakeNetwork()
    val space = FakeSpace()
    val scheduler = RecordingScheduler()
    val eligibility = FixedEligibility()
    val gguf = SpyGgufInspector()
    val journal = SpyJournal()
    val trust = TestTrust(signer.keysJson(), signer.envelope(Fixtures.payload(sha, model.size.toLong())))
    val layout = StorageLayout(File(root, "namu-models"))

    /** Arm with `hook.target = "<checkpoint>"` to kill the "process" there (T10). */
    val hook = CrashAt(null)
    var service = newService()

    fun newService(j: Journal = journal, hook: CrashHook = this.hook, internalBuild: Boolean = true): TransferService =
        TransferService(
            ServiceConfig(server.origin, appBuild = 100, runtimeBuildId = Fixtures.RUNTIME, internalBuild = internalBuild),
            TransferEngine.newHttpClient(), j, layout, trust, TinkEd25519Verifier(), network, space,
            eligibility, scheduler, clock, sleeper, RetryPolicy { 0.0 }, gguf, hook, NioDirectorySyncer,
        )

    /** Process death + relaunch: a new service over the same files and the same durable journal. */
    fun restart() {
        service = newService()
    }

    fun run(id: String): RunOutcome = service.runTransfer(id, service.newControl())
    fun row(id: String): TransferRecord = journal.get(id)!!
    fun part(id: String): File = layout.stagingFile(id)
    fun release(artifact: String = sha): File = layout.releaseFile(artifact)

    /** start → run → beginSelfTest → activate(pass). */
    fun installBundled(): String {
        val id = service.start("bundled", false)
        check(run(id) is RunOutcome.Staged)
        service.beginSelfTest(id)
        service.activate(id, true, "")
        return id
    }

    fun close() = server.shutdown()

    companion object {
        /** > 8 MiB so the 4 MiB commit rule fires more than once. */
        const val MODEL_BYTES = 9 * 1024 * 1024 + 12_345
    }
}
