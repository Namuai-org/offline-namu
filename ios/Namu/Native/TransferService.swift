import Foundation
import Network
import UIKit

/// Model delivery service (PRD §7–8, contract §4–6).
///
/// Runs with no JS runtime alive (ARC-003): AppDelegate creates the singleton
/// at launch so background URLSession events are handled before React starts.
/// Every piece of mutable state lives on `queue`; the URLSession delegate queue
/// targets the same serial queue, so callbacks and API calls never interleave.
final class TransferService: NSObject {
  static let shared = TransferService()

  typealias Completion<T> = (Result<T, NamuError>) -> Void

  private let queue = DispatchQueue(label: "org.namuai.offline.transfer")
  private let verifyQueue = DispatchQueue(label: "org.namuai.offline.transfer.verify", qos: .utility)

  private let config: NamuBuildConfig
  private let storeRoot: URL
  private let sessionIdentifier: String
  private var store: ModelStore?

  /// The app uses `shared`. Tests inject a configuration, a temporary storage
  /// root and a unique background-session identifier.
  init(
    config: NamuBuildConfig = NamuBuildConfig.current, storeRoot: URL = ModelStore.defaultRoot(),
    sessionIdentifier: String? = nil
  ) {
    self.config = config
    self.storeRoot = storeRoot
    // Contract §6.3: one background session, identifier <bundleId>.model-transfer.
    self.sessionIdentifier = sessionIdentifier ?? "\(config.bundleId).model-transfer"
    super.init()
  }
  private var started = false
  private var ready = false
  private var pendingCalls = [() -> Void]()

  // URLSession (contract §6.3)
  private var session: URLSession?
  private var sessionAllowsMetered = false
  private var sessionInvalidating = false
  private var afterInvalidation = [() -> Void]()
  private var liveTasks = [String: URLSessionDownloadTask]()
  private var expectedCancellations = Set<Int>()
  private var validatedTasks = Set<Int>()
  private var resumedTasks = Set<Int>() // created from resume data, offset not confirmed yet
  private var backgroundCompletionHandler: (() -> Void)?

  // Live progress that is not journaled on every callback
  private var liveCommitted = [String: Int64]()
  private var liveVerified = [String: Int64]()
  private var lastProgressJournalAt = [String: Int64]()
  private var lastSpaceCheckAt: Int64 = 0
  private var verifying = Set<String>()
  private var cancelledVerifications = Set<String>()

  // Network (DL-006)
  private let pathMonitor = NWPathMonitor()
  private var networkConnected = true
  private var networkMetered = false

  // Verified update descriptor cached for snapshots (SIG-005)
  private var updateSummary: (descriptor: ReleaseDescriptor, envelope: Data)?

  // Snapshot fan-out (contract §6.1: ≥ 250 ms apart, phase changes flush)
  private var listeners = [UUID: (String) -> Void]()
  private var lastPublishAt: Int64 = 0
  private var publishScheduled = false

  static let retryDelays: [Double] = [2, 5, 15, 30, 60] // DL-007
  static let maxRetryAfter: Double = 15 * 60

  // MARK: - Lifecycle

  /// Called from AppDelegate at launch, before React Native starts.
  func start() {
    queue.async { [self] in
      guard !started else { return }
      started = true
      do {
        let store = try ModelStore(root: storeRoot, bundledKnownBad: config.bundledKnownBad)
        try store.reconcile() // before the first snapshot is answered
        self.store = store
      } catch {
        // Storage is unusable: every call rejects with STORAGE_WRITE_FAILED.
        store = nil
        becomeReady()
        return
      }
      loadStoredUpdate()
      pathMonitor.pathUpdateHandler = { [weak self] path in self?.networkChanged(path) }
      pathMonitor.start(queue: queue)
      let consent = inFlightTransfers().first?.meteredConsent ?? false
      let session = makeSession(allowMetered: consent)
      // Reconnect to tasks the OS kept running while the app was not (DL-005).
      session.getAllTasks { [weak self] tasks in
        self?.queue.async { self?.reconcileTasks(tasks) }
      }
    }
  }

  private func becomeReady() {
    ready = true
    let calls = pendingCalls
    pendingCalls.removeAll()
    calls.forEach { $0() }
  }

  /// Runs `body` on the service queue once startup reconciliation finished.
  private func perform(_ body: @escaping () -> Void) {
    queue.async { [self] in
      if !started { start() }
      queue.async { [self] in
        if ready { body() } else { pendingCalls.append(body) }
      }
    }
  }

  private func requireStore() throws -> ModelStore {
    guard let store else { throw NamuError(NamuError.storageWriteFailed, "model store unavailable") }
    return store
  }

  /// `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
  func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) {
    queue.async { [self] in
      guard identifier == sessionIdentifier else {
        DispatchQueue.main.async(execute: completionHandler)
        return
      }
      backgroundCompletionHandler = completionHandler
    }
    start()
  }

  /// Test teardown: cancels OS tasks and invalidates the background session so
  /// nothing outlives the test that created it.
  func shutdown(_ completion: @escaping () -> Void) {
    queue.async { [self] in
      pathMonitor.cancel()
      listeners.removeAll()
      cancelledVerifications.formUnion(verifying)
      guard let session else { completion(); return }
      liveTasks.values.forEach { expectedCancellations.insert($0.taskIdentifier) }
      liveTasks.removeAll()
      sessionInvalidating = true
      afterInvalidation.append(completion)
      session.invalidateAndCancel()
    }
  }

  // MARK: - Listeners and snapshots

  func addSnapshotListener(_ listener: @escaping (String) -> Void) -> UUID {
    let token = UUID()
    queue.async { self.listeners[token] = listener }
    return token
  }

  func removeSnapshotListener(_ token: UUID) {
    queue.async { self.listeners[token] = nil }
  }

  func snapshot(_ completion: @escaping Completion<String>) {
    perform { [self] in completion(Result { try snapshotJSON() }.mapError { NamuError.wrap($0, fallback: NamuError.storageWriteFailed) }) }
  }

  private func publish(force: Bool = false) {
    let now = namuNowMs()
    if force || now - lastPublishAt >= 250 {
      lastPublishAt = now
      guard !listeners.isEmpty, let json = try? snapshotJSON() else { return }
      listeners.values.forEach { $0(json) }
    } else if !publishScheduled {
      publishScheduled = true
      let delay = max(1, 250 - (now - lastPublishAt))
      queue.asyncAfter(deadline: .now() + .milliseconds(Int(delay))) { [self] in
        publishScheduled = false
        publish(force: true)
      }
    }
  }

  private func currentTransfer(_ store: ModelStore) -> TransferRecord? {
    (try? store.journal.allTransfers())?.first
  }

  private func inFlightTransfers() -> [TransferRecord] {
    ((try? store?.journal.allTransfers()) ?? []).filter { $0.phase.isInFlight }
  }

  private func entryJSON(_ entry: ActiveEntry?) -> Any {
    guard let entry else { return NSNull() }
    return ["artifactId": entry.artifactId, "version": entry.version, "bytes": entry.bytes,
            "sha256": entry.sha256, "activatedAt": entry.activatedAt]
  }

  private func snapshotJSON() throws -> String {
    let store = try requireStore()
    let free = store.freeBytes()
    var required: Int64 = 0
    var transferJSON: Any = NSNull()

    if let t = currentTransfer(store) {
      let committed = max(t.committedBytes, liveCommitted[t.transferId] ?? 0)
      let verified = max(t.verifiedBytes, liveVerified[t.transferId] ?? 0)
      if t.phase.isInFlight && t.stagedFilename == nil {
        let durable = t.resumeData != nil || liveTasks[t.transferId] != nil ? committed : 0
        required = max(0, (t.expectedBytes - durable) + NamuConstants.startReserveBytes - free)
      }
      let errorCode: Any = (t.phase == .failed || t.phase == .waiting) ? (t.lastError ?? NSNull() as Any) : NSNull()
      transferJSON = [
        "transferId": t.transferId, "isUpdate": t.descriptorSource == DescriptorSource.update.rawValue,
        "artifactVersion": t.artifactVersion, "artifactSha256": t.artifactSha256,
        "phase": t.phase.rawValue, "expectedBytes": t.expectedBytes,
        "committedBytes": min(committed, t.expectedBytes), "verifiedBytes": min(verified, t.expectedBytes),
        "meteredConsent": t.meteredConsent, "userPaused": t.userPaused,
        "restartedFromZero": t.restartedFromZero, "retryCount": t.retryCount,
        "nextRetryAt": t.nextRetryAt.map { $0 as Any } ?? NSNull(), "errorCode": errorCode,
      ] as [String: Any]
    } else if store.installState != .installed, case .accepted(let bundled, _)? = verifyBundled(store) {
      // S02 shows the additional storage needed before the first download.
      required = max(0, bundled.bytes + NamuConstants.startReserveBytes - free)
    }

    var updateJSON: Any = NSNull()
    if let update = updateSummary?.descriptor, update.sha256 != store.pointer?.active.sha256 {
      updateJSON = ["artifactVersion": update.artifactVersion, "bytes": update.bytes, "sequence": update.sequence]
    }

    let root: [String: Any] = [
      "schema": 1,
      "install": [
        "state": store.installState.rawValue,
        "active": entryJSON(store.pointer?.active),
        "previous": entryJSON(store.pointer?.previous),
        "canRestorePrevious": store.canRestorePrevious,
      ] as [String: Any],
      "transfer": transferJSON,
      "update": updateJSON,
      "network": ["connected": networkConnected, "metered": networkMetered],
      "storage": ["freeBytes": free, "requiredAdditionalBytes": required],
    ]
    return String(decoding: try JSONSerialization.data(withJSONObject: root), as: UTF8.self)
  }

  // MARK: - Descriptors (SIG-001…005)

  private func context(_ source: DescriptorSource, store: ModelStore) -> DescriptorContext {
    DescriptorContext(
      keys: config.keys, source: source, appBuild: config.appBuild, runtimeBuildId: config.runtimeBuildId,
      nowMs: namuNowMs(), highestSequence: store.journal.highestSequence,
      highestSequencePayloadSha256: store.journal.highestSequencePayloadSha256,
      knownBad: store.knownBad(), profile: config.profile)
  }

  private func verifyBundled(_ store: ModelStore) -> DescriptorVerification? {
    guard let envelope = config.bundledDescriptor else { return nil }
    return DescriptorVerifier.verify(envelope: envelope, context: context(.bundled, store: store))
  }

  private func loadStoredUpdate() {
    guard let store, let b64 = try? store.journal.meta(TransferJournal.MetaKey.updateDescriptor),
          let envelope = Data(base64Encoded: b64) else { return }
    if case .accepted(let descriptor, _) = DescriptorVerifier.verify(envelope: envelope, context: context(.update, store: store)) {
      updateSummary = (descriptor, envelope)
    } else {
      // SIG-004: expired or no longer acceptable metadata authorizes nothing.
      try? store.journal.setMeta(TransferJournal.MetaKey.updateDescriptor, nil)
    }
  }

  func bundledDescriptorSummary(_ completion: @escaping Completion<String>) {
    perform { [self] in
      var body: [String: Any] = ["valid": false, "artifactVersion": NSNull(), "bytes": NSNull(),
                                 "sha256": NSNull(), "errorCode": NamuError.signatureInvalid]
      if let store, let result = verifyBundled(store) {
        switch result {
        case .accepted(let d, _):
          body = ["valid": true, "artifactVersion": d.artifactVersion, "bytes": d.bytes, "sha256": d.sha256,
                  "errorCode": NSNull()]
        case .rejected(let code, _):
          body["errorCode"] = code
        }
      }
      let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
      completion(.success(String(decoding: data, as: UTF8.self)))
    }
  }

  /// User initiated only (SIG-005). Never starts a transfer by itself.
  func checkForUpdate(_ completion: @escaping Completion<String>) {
    perform { [self] in
      func finish(_ status: String, _ code: String?) {
        let body: [String: Any] = ["status": status, "errorCode": code ?? NSNull() as Any]
        let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
        completion(.success(String(decoding: data, as: UTF8.self)))
        publish(force: true)
      }
      guard let store, let origin = config.modelOrigin, let url = URL(string: origin + "/releases/stable.json") else {
        finish("error", NamuError.signatureInvalid)
        return
      }
      DescriptorFetcher.fetch(url: url, origin: origin) { [weak self] result in
        self?.queue.async {
          guard let self else { return }
          switch result {
          case .failure(let error):
            finish("error", error.code)
          case .success(let envelope):
            switch DescriptorVerifier.verify(envelope: envelope, context: self.context(.update, store: store)) {
            case .rejected(let code, _):
              finish("error", code)
            case .accepted(let descriptor, let payloadSha256):
              do {
                try store.journal.recordAcceptedSequence(descriptor.sequence, payloadSha256: payloadSha256)
                try store.journal.setMeta(TransferJournal.MetaKey.updateDescriptor, envelope.base64EncodedString())
              } catch {
                finish("error", NamuError.storageWriteFailed)
                return
              }
              self.updateSummary = (descriptor, envelope)
              finish(descriptor.sha256 == store.pointer?.active.sha256 ? "none" : "available", nil)
            }
          }
        }
      }
    }
  }

  // MARK: - start / pause / resume / cancel (DL-001)

  func start(source: String, allowMetered: Bool, completion: @escaping Completion<String>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard let descriptorSource = DescriptorSource(rawValue: source) else {
          throw NamuError(NamuError.invalidState, "unknown source")
        }
        guard config.modelOrigin != nil else { throw NamuError(NamuError.invalidState, "model origin not allowed") }
        let envelope: Data
        switch descriptorSource {
        case .bundled:
          guard let bundled = config.bundledDescriptor else {
            throw NamuError(NamuError.signatureInvalid, "bundled descriptor missing")
          }
          envelope = bundled
        case .update:
          guard let stored = updateSummary?.envelope else { throw NamuError(NamuError.notFound, "no update") }
          envelope = stored
        }
        // Trusted descriptor first (DL-010); re-verified with the current time.
        let descriptor: ReleaseDescriptor
        let payloadSha256: String
        switch DescriptorVerifier.verify(envelope: envelope, context: context(descriptorSource, store: store)) {
        case .accepted(let d, let hash): (descriptor, payloadSha256) = (d, hash)
        case .rejected(let code, let reason): throw NamuError(code, reason)
        }

        if var existing = try store.journal.transfer(artifactSha256: descriptor.sha256) {
          switch existing.phase {
          case .waiting, .downloading, .paused, .verifying, .staged, .selfTesting:
            completion(.success(existing.transferId)) // idempotent
            return
          case .installed:
            let intact = store.releaseIsIntact(artifactId: existing.artifactSha256, bytes: existing.expectedBytes)
            if store.pointer?.active.artifactId == existing.artifactSha256, store.installState == .installed {
              completion(.success(existing.transferId))
              return
            }
            if intact, store.pointer?.previous?.artifactId == existing.artifactSha256 {
              // Signed rollback to the retained previous artifact (SIG-005):
              // the verified release is already on disk.
              existing.phase = .staged
              existing.descriptorSource = descriptorSource.rawValue
              existing.descriptorBytes = envelope
              existing.descriptorHash = payloadSha256
              try store.journal.save(existing)
              publish(force: true)
              completion(.success(existing.transferId))
              return
            }
            try store.journal.deleteTransfer(id: existing.transferId) // needs repair: download again
          case .failed:
            if existing.lastError == NamuError.transferRetry {
              // TRANSFER_RETRY keeps valid partial data: retry is a resume.
              let existingId = existing.transferId
              resumeLocked(existing, allowMetered: allowMetered) { result in
                completion(result.map { existingId })
              }
              return
            }
            store.removeStagingFile(transferId: existing.transferId)
            try store.journal.deleteTransfer(id: existing.transferId)
          case .removing, .absent:
            throw NamuError(NamuError.invalidState, "transfer is being removed")
          }
        }
        guard inFlightTransfers().isEmpty else {
          throw NamuError(NamuError.invalidState, "another transfer is active")
        }

        // DL-009: free ≥ (B − P) + 1 GiB with P = 0 for a fresh transfer.
        guard store.freeBytes() >= descriptor.bytes + NamuConstants.startReserveBytes else {
          throw NamuError(NamuError.spaceLow, "insufficient space")
        }

        let now = namuNowMs()
        let record = TransferRecord(
          transferId: UUID().uuidString.lowercased(), descriptorSource: descriptorSource.rawValue,
          descriptorBytes: envelope, descriptorHash: payloadSha256, artifactVersion: descriptor.artifactVersion,
          artifactSha256: descriptor.sha256, artifactPath: descriptor.path, phase: .waiting,
          expectedBytes: descriptor.bytes, meteredConsent: allowMetered, createdAt: now, updatedAt: now)
        let (row, created) = try store.journal.createOrGet(record)
        if created { beginDownload(row, delay: nil) }
        publish(force: true)
        completion(.success(row.transferId))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  func pause(transferId: String, completion: @escaping Completion<Void>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard var record = try store.journal.transfer(id: transferId) else {
          throw NamuError(NamuError.notFound, "transfer")
        }
        guard record.phase == .waiting || record.phase == .downloading else {
          completion(.success(())) // already paused, or nothing left to pause
          return
        }
        // DL-006: pause is persistent until the user resumes.
        record.userPaused = true
        record.phase = .paused
        record.lastError = nil
        record.nextRetryAt = nil
        record.committedBytes = max(record.committedBytes, liveCommitted[transferId] ?? 0)
        try store.journal.save(record)
        publish(force: true)
        stopTask(transferId: transferId, produceResumeData: true) { [self] resumeData in
          if var latest = try? store.journal.transfer(id: transferId), latest.phase == .paused {
            if let resumeData { latest.resumeData = resumeData }
            latest.osTaskId = nil
            try? store.journal.save(latest)
          }
          publish(force: true)
          completion(.success(()))
        }
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  func resume(transferId: String, allowMetered: Bool, completion: @escaping Completion<Void>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard let record = try store.journal.transfer(id: transferId) else {
          throw NamuError(NamuError.notFound, "transfer")
        }
        resumeLocked(record, allowMetered: allowMetered, completion: completion)
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  private func resumeLocked(_ row: TransferRecord, allowMetered: Bool, completion: @escaping Completion<Void>) {
    do {
      let store = try requireStore()
      var record = row
      switch record.phase {
      case .verifying, .staged, .selfTesting, .installed:
        completion(.success(())) // nothing to resume
        return
      case .removing, .absent:
        throw NamuError(NamuError.invalidState, "transfer is being removed")
      case .failed:
        let retryable = [NamuError.transferRetry, NamuError.transferRestart, NamuError.networkWait, NamuError.spaceLow]
        guard retryable.contains(record.lastError ?? "") else {
          throw NamuError(NamuError.invalidState, "transfer failed permanently; start again")
        }
      case .waiting, .downloading, .paused:
        break
      }

      // A completed download that could not be verified yet (low space, kill).
      if let staged = try? store.stagingURL(transferId: record.transferId), record.stagedFilename != nil,
         FileManager.default.fileExists(atPath: staged.path) {
        record.userPaused = false
        record.phase = .verifying
        record.lastError = nil
        try store.journal.save(record)
        publish(force: true)
        startVerification(record)
        completion(.success(()))
        return
      }

      let hasLiveTask = liveTasks[record.transferId] != nil
      let durable = (record.resumeData != nil || hasLiveTask)
        ? max(record.committedBytes, liveCommitted[record.transferId] ?? 0) : 0
      guard store.freeBytes() >= (record.expectedBytes - durable) + NamuConstants.startReserveBytes else {
        throw NamuError(NamuError.spaceLow, "insufficient space")
      }

      // DL-006: consent is per transfer and given again on every resume.
      record.userPaused = false
      record.meteredConsent = allowMetered
      record.retryCount = 0
      if hasLiveTask && sessionAllowsMetered == allowMetered && record.phase != .paused {
        // The OS task is alive under the right policy. A pending back-off keeps
        // its schedule (and its reason) rather than throwing resume data away.
        let backingOff = record.phase == .waiting && record.lastError == NamuError.transferRetry
        if !backingOff {
          record.nextRetryAt = nil
          record.lastError = nil
        }
        if record.phase == .failed { record.phase = .downloading }
        try store.journal.save(record)
        evaluateNetworkWait()
        publish(force: true)
        completion(.success(()))
        return
      }
      record.nextRetryAt = nil
      record.lastError = nil
      record.phase = .waiting
      try store.journal.save(record)
      stopTask(transferId: record.transferId, produceResumeData: true) { [self] resumeData in
        var latest = (try? store.journal.transfer(id: record.transferId)) ?? record
        if let resumeData { latest.resumeData = resumeData }
        beginDownload(latest, delay: nil)
        publish(force: true)
        completion(.success(()))
      }
    } catch {
      completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
    }
  }

  func cancel(transferId: String, completion: @escaping Completion<Void>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard let record = try store.journal.transfer(id: transferId) else {
          completion(.success(())) // idempotent by transfer ID
          return
        }
        if record.phase == .installed || store.isReferencedByPointer(record.artifactSha256) {
          completion(.success(())) // nothing in flight; the installed model is never touched
          return
        }
        cancelledVerifications.insert(transferId)
        stopTask(transferId: transferId, produceResumeData: false) { [self] _ in
          store.removeStagingFile(transferId: transferId)
          if store.readMarker()?.transferId == transferId { try? store.deleteMarker() }
          try? store.removeRelease(artifactId: record.artifactSha256)
          try? store.journal.deleteTransfer(id: transferId)
          liveCommitted[transferId] = nil
          liveVerified[transferId] = nil
          publish(force: true)
          completion(.success(()))
        }
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  // MARK: - Self-test and activation (DL-010…012)

  func beginSelfTest(transferId: String, completion: @escaping Completion<String>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard var record = try store.journal.transfer(id: transferId) else {
          throw NamuError(NamuError.notFound, "transfer")
        }
        if record.phase == .selfTesting, store.readMarker()?.transferId == transferId {
          completion(.success(record.artifactSha256)) // idempotent
          return
        }
        guard record.phase == .staged else { throw NamuError(NamuError.invalidState, "transfer is not staged") }
        guard store.releaseIsIntact(artifactId: record.artifactSha256, bytes: record.expectedBytes) else {
          throw NamuError(NamuError.fileDamaged, "staged release missing")
        }
        guard !store.knownBad().contains(record.artifactSha256) else {
          throw NamuError(NamuError.fileDamaged, "known-bad artifact")
        }
        // Marker first, durably; a crash from here on quarantines the candidate.
        try store.writeMarker(PendingActivationMarker(
          transferId: transferId, artifactId: record.artifactSha256, startedAt: namuNowMs()))
        record.phase = .selfTesting
        try store.journal.save(record)
        publish(force: true)
        completion(.success(record.artifactSha256))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  func activate(transferId: String, selfTestPassed: Bool, failureCode: String, completion: @escaping Completion<String>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard let record = try store.journal.transfer(id: transferId) else {
          throw NamuError(NamuError.notFound, "transfer")
        }
        if record.phase == .installed, selfTestPassed {
          completion(.success(try snapshotJSON())) // idempotent
          return
        }
        guard record.phase == .selfTesting else { throw NamuError(NamuError.invalidState, "self-test not started") }
        if selfTestPassed {
          // DL-009: recheck space before activation; the old pointer survives.
          guard store.freeBytes() >= NamuConstants.runningReserveBytes else {
            throw NamuError(NamuError.spaceLow, "insufficient space")
          }
          try store.activate(transfer: record)
        } else {
          let code = NamuError.productCodes.contains(failureCode) ? failureCode : NamuError.modelLoadFailed
          try store.failActivation(transfer: record, code: code)
        }
        publish(force: true)
        completion(.success(try snapshotJSON()))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  func resolveArtifactPath(artifactId: String, completion: @escaping Completion<String>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard NamuPattern.isSha256Hex(artifactId) else { throw NamuError(NamuError.notFound, "artifact") }
        var bytes: Int64?
        if store.pointer?.active.artifactId == artifactId { bytes = store.pointer?.active.bytes }
        if store.pointer?.previous?.artifactId == artifactId { bytes = store.pointer?.previous?.bytes }
        if bytes == nil, let row = try store.journal.transfer(artifactSha256: artifactId),
           row.phase == .selfTesting || row.phase == .staged {
          bytes = row.expectedBytes // the self-test loads the verified candidate
        }
        // Only files under releases/ are ever returned: they passed length,
        // SHA-256 and the structural check (DL-010).
        guard let bytes, store.releaseIsIntact(artifactId: artifactId, bytes: bytes) else {
          throw NamuError(NamuError.notFound, "artifact")
        }
        completion(.success(try store.releaseFileURL(artifactId: artifactId).path))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.notFound)))
      }
    }
  }

  func setRuntimeReference(_ artifactId: String) {
    perform { [self] in
      store?.runtimeReference = artifactId.isEmpty ? nil : artifactId
      if artifactId.isEmpty { store?.applyRetention() } // delete when idle (DL-013)
    }
  }

  func noteSuccessfulForegroundSession(_ completion: @escaping Completion<Void>) {
    perform { [self] in
      do {
        try requireStore().noteSuccessfulSession()
        publish(force: true)
        completion(.success(()))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  /// DL-013. `markAbandonedBad` is the automatic failed-trial restore requested
  /// by JS when the active artifact fails to load during its trial: the
  /// abandoned digest becomes locally bad and its release is removed. `false`
  /// is the manual "Restore previous version" swap; nothing is deleted.
  func restorePrevious(markAbandonedBad: Bool, completion: @escaping Completion<String>) {
    perform { [self] in
      do {
        try requireStore().restorePrevious(mode: markAbandonedBad ? .failedTrial : .userSwap)
        publish(force: true)
        completion(.success(try snapshotJSON()))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  /// DL-014: explicit repair rehashes the active artifact.
  func repair(_ completion: @escaping Completion<String>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard let active = store.pointer?.active else { throw NamuError(NamuError.invalidState, "nothing installed") }
        guard store.runtimeReference != active.artifactId else {
          throw NamuError(NamuError.engineBusy, "runtime reference")
        }
        let url = try store.releaseFileURL(artifactId: active.artifactId)
        let intact = store.releaseIsIntact(artifactId: active.artifactId, bytes: active.bytes)
        let background = UIApplication.shared.beginBackgroundTask(withName: "namu.repair", expirationHandler: nil)
        verifyQueue.async { [self] in
          let healthy = intact && (try? Sha256Streamer.hashFile(at: url)) == active.sha256
          queue.async { [self] in
            defer { UIApplication.shared.endBackgroundTask(background) }
            do {
              if healthy {
                try store.reconcile()
              } else if store.canRestorePrevious {
                try store.restorePrevious(mode: .replaceDamaged)
              } else {
                store.markActiveDamaged()
              }
              publish(force: true)
              completion(.success(try snapshotJSON()))
            } catch {
              completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
            }
          }
        }
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  func removeModel(_ completion: @escaping Completion<Void>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard store.runtimeReference == nil else { throw NamuError(NamuError.engineBusy, "runtime reference") }
        cancelAllTasks()
        try store.removeAllModels()
        resetLiveState()
        publish(force: true)
        completion(.success(()))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  /// SEC-006: cancels transfers, removes journal, staging, releases, pointer.
  func deleteAllTransferData(_ completion: @escaping Completion<Void>) {
    perform { [self] in
      do {
        let store = try requireStore()
        guard store.runtimeReference == nil else { throw NamuError(NamuError.engineBusy, "runtime reference") }
        cancelAllTasks()
        try store.deleteEverything()
        updateSummary = nil
        resetLiveState()
        publish(force: true)
        completion(.success(()))
      } catch {
        completion(.failure(NamuError.wrap(error, fallback: NamuError.storageWriteFailed)))
      }
    }
  }

  private func resetLiveState() {
    liveCommitted.removeAll()
    liveVerified.removeAll()
    lastProgressJournalAt.removeAll()
    cancelledVerifications.formUnion(verifying)
  }

  // MARK: - URLSession plumbing (contract §6.3)

  @discardableResult
  private func makeSession(allowMetered: Bool) -> URLSession {
    let configuration = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    // DL-006: unmetered only unless this transfer carries explicit consent.
    configuration.allowsCellularAccess = allowMetered
    configuration.allowsExpensiveNetworkAccess = allowMetered
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    // The artifact is never content-encoded (DST-002); refuse transformations.
    configuration.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    delegateQueue.underlyingQueue = queue // serial delegate queue
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    self.session = session
    sessionAllowsMetered = allowMetered
    return session
  }

  /// Hands out a session whose metered policy matches the transfer's consent.
  /// The policy lives in the session configuration, so a consent change
  /// rebuilds the session; resume data stays opaque and untouched (DL-005).
  private func withSession(allowMetered: Bool, _ body: @escaping (URLSession) -> Void) {
    if sessionInvalidating {
      afterInvalidation.append { [self] in withSession(allowMetered: allowMetered, body) }
      return
    }
    if let session, sessionAllowsMetered == allowMetered {
      body(session)
      return
    }
    guard let old = session else {
      body(makeSession(allowMetered: allowMetered))
      return
    }
    sessionInvalidating = true
    afterInvalidation.append { [self] in body(makeSession(allowMetered: allowMetered)) }
    liveTasks.values.forEach { expectedCancellations.insert($0.taskIdentifier) }
    liveTasks.removeAll()
    old.invalidateAndCancel()
  }

  /// Cancels the OS task of a transfer. The continuation always runs on `queue`.
  private func stopTask(transferId: String, produceResumeData: Bool, then: @escaping (Data?) -> Void) {
    guard let task = liveTasks.removeValue(forKey: transferId) else {
      then(nil)
      return
    }
    expectedCancellations.insert(task.taskIdentifier)
    if produceResumeData {
      task.cancel(byProducingResumeData: { [weak self] data in self?.queue.async { then(data) } })
    } else {
      task.cancel()
      then(nil)
    }
  }

  private func cancelAllTasks() {
    for (_, task) in liveTasks {
      expectedCancellations.insert(task.taskIdentifier)
      task.cancel()
    }
    liveTasks.removeAll()
  }

  private func artifactURL(_ record: TransferRecord) -> URL? {
    // Artifact URL = MODEL_ORIGIN + "/" + signed relative path (contract §4).
    guard let origin = config.modelOrigin, DescriptorVerifier.isValidPath(record.artifactPath) else { return nil }
    return URL(string: origin + "/" + record.artifactPath)
  }

  /// Creates the background download task. `delay` schedules a DL-007 retry
  /// through `earliestBeginDate`, which the OS honours without our process.
  private func beginDownload(_ row: TransferRecord, delay: Double?) {
    guard let store, let url = artifactURL(row) else { return }
    var record = row
    withSession(allowMetered: record.meteredConsent) { [self] session in
      let task: URLSessionDownloadTask
      if let resumeData = record.resumeData {
        task = session.downloadTask(withResumeData: resumeData) // opaque; never inspected
        resumedTasks.insert(task.taskIdentifier)
      } else {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpShouldHandleCookies = false
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        task = session.downloadTask(with: request)
        if record.committedBytes > 0 || (liveCommitted[record.transferId] ?? 0) > 0 {
          // DL-005: no usable resume data → visibly restart from zero.
          record.restartedFromZero = true
        }
        record.committedBytes = 0
        liveCommitted[record.transferId] = 0
      }
      task.taskDescription = record.transferId
      task.countOfBytesClientExpectsToReceive = max(0, record.expectedBytes - record.committedBytes)
      if let delay { task.earliestBeginDate = Date().addingTimeInterval(delay) }
      record.osTaskId = String(task.taskIdentifier)
      record.resumeData = nil // consumed by the OS task
      if delay != nil {
        record.phase = .waiting
        record.lastError = NamuError.transferRetry
      } else if !networkAllows(record) {
        record.phase = .waiting
        record.lastError = NamuError.networkWait
      } else {
        record.phase = .downloading
        record.lastError = nil
      }
      try? store.journal.save(record)
      liveTasks[record.transferId] = task
      task.resume()
      publish(force: true)
    }
  }

  private func reconcileTasks(_ tasks: [URLSessionTask]) {
    defer { becomeReady() }
    guard let store else { return }
    let rows = (try? store.journal.allTransfers()) ?? []
    for task in tasks {
      guard let download = task as? URLSessionDownloadTask, let id = task.taskDescription,
            let row = rows.first(where: { $0.transferId == id }),
            row.osTaskId == String(task.taskIdentifier),
            row.phase == .downloading || row.phase == .waiting,
            task.state == .running || task.state == .suspended else {
        if task.state == .running || task.state == .suspended {
          expectedCancellations.insert(task.taskIdentifier)
          task.cancel() // unknown to the journal: never adopt it
        }
        continue
      }
      liveTasks[id] = download
      liveCommitted[id] = max(row.committedBytes, download.countOfBytesReceived)
    }
    for row in rows {
      switch row.phase {
      case .verifying:
        if let staged = try? store.stagingURL(transferId: row.transferId),
           FileManager.default.fileExists(atPath: staged.path) {
          startVerification(row) // killed while hashing: start over
        } else {
          fail(row, code: NamuError.fileDamaged)
        }
      case .downloading, .waiting:
        guard liveTasks[row.transferId] == nil, row.stagedFilename == nil else { continue }
        // Completion events of tasks that finished while the app was dead are
        // delivered right after session creation; give them a moment.
        let expectedTask = row.osTaskId
        queue.asyncAfter(deadline: .now() + 3) { [self] in
          guard let latest = try? store.journal.transfer(id: row.transferId),
                latest.phase == .downloading || latest.phase == .waiting,
                latest.osTaskId == expectedTask, liveTasks[latest.transferId] == nil else { return }
          // T12: the OS task is gone (force-quit, reboot). Never resume
          // silently; the user decides (DL-006).
          fail(latest, code: NamuError.transferRetry, keepResumeData: true)
        }
      default:
        break
      }
    }
    evaluateNetworkWait()
  }

  private func fail(_ row: TransferRecord, code: String, keepResumeData: Bool = false) {
    guard let store else { return }
    var record = row
    record.phase = .failed
    record.lastError = code
    record.nextRetryAt = nil
    record.osTaskId = nil
    record.committedBytes = max(record.committedBytes, liveCommitted[record.transferId] ?? 0)
    if !keepResumeData {
      record.resumeData = nil
      record.committedBytes = 0
      record.stagedFilename = nil
      liveCommitted[record.transferId] = nil
      store.removeStagingFile(transferId: record.transferId) // corrupt staging only
    }
    try? store.journal.save(record)
    publish(force: true)
  }

  /// DL-007: 2, 5, 15, 30, 60 s with up to +20 % jitter; Retry-After ≤ 15 min.
  /// The failure of the fifth automatic retry requires a user retry.
  private func scheduleRetry(_ row: TransferRecord, resumeData: Data?, retryAfter: Double?) {
    guard let store else { return }
    var record = row
    record.retryCount += 1
    record.osTaskId = nil
    record.resumeData = resumeData
    record.committedBytes = max(record.committedBytes, liveCommitted[record.transferId] ?? 0)
    guard record.retryCount <= TransferService.retryDelays.count else {
      record.phase = .failed
      record.lastError = NamuError.transferRetry
      record.nextRetryAt = nil
      try? store.journal.save(record)
      publish(force: true)
      return
    }
    var delay = TransferService.retryDelays[record.retryCount - 1] * (1 + Double.random(in: 0...0.2))
    if let retryAfter, retryAfter > 0 { delay = max(delay, min(retryAfter, TransferService.maxRetryAfter)) }
    record.nextRetryAt = namuNowMs() + Int64(delay * 1000)
    try? store.journal.save(record)
    beginDownload(record, delay: delay)
  }

  // MARK: - Network policy (DL-006)

  private func networkAllows(_ record: TransferRecord) -> Bool {
    networkConnected && (!networkMetered || record.meteredConsent)
  }

  private func networkChanged(_ path: NWPath) {
    networkConnected = path.status == .satisfied
    networkMetered = path.isExpensive
    evaluateNetworkWait()
    publish(force: true)
  }

  /// Loss of network is `waiting/NETWORK_WAIT`, never a failure. The background
  /// task itself keeps waiting for connectivity inside the OS.
  private func evaluateNetworkWait() {
    guard let store else { return }
    for var row in inFlightTransfers() where liveTasks[row.transferId] != nil {
      if row.phase == .downloading, !networkAllows(row) {
        row.phase = .waiting
        row.lastError = NamuError.networkWait
        try? store.journal.save(row)
      } else if row.phase == .waiting, row.lastError == NamuError.networkWait, networkAllows(row) {
        row.phase = .downloading
        row.lastError = nil
        try? store.journal.save(row)
      }
    }
  }

  // MARK: - Verification and installation (contract §6.4)

  private func startVerification(_ row: TransferRecord) {
    guard let store, verifying.insert(row.transferId).inserted else { return }
    cancelledVerifications.remove(row.transferId)
    let id = row.transferId
    // Hashing ~2 GB takes seconds; ask for time if we were woken in background.
    let background = UIApplication.shared.beginBackgroundTask(withName: "namu.verify", expirationHandler: nil)
    verifyQueue.async { [self] in
      let result = Result { try self.verifyStagedFile(row, store: store) }
      queue.async { [self] in
        defer { UIApplication.shared.endBackgroundTask(background) }
        verifying.remove(id)
        guard cancelledVerifications.remove(id) == nil,
              var record = try? store.journal.transfer(id: id), record.phase == .verifying else { return }
        do {
          try result.get()
          // DL-009: recheck space before producing the release.
          guard store.freeBytes() >= NamuConstants.runningReserveBytes else {
            record.phase = .waiting
            record.lastError = NamuError.spaceLow
            try store.journal.save(record)
            publish(force: true)
            return
          }
          try store.installVerifiedFile(
            from: try store.stagingURL(transferId: id), artifactId: record.artifactSha256,
            expectedBytes: record.expectedBytes)
          record.phase = .staged
          record.verifiedBytes = record.expectedBytes
          record.stagedFilename = nil
          record.lastError = nil
          try store.journal.save(record)
          publish(force: true)
        } catch {
          // Signature, hash and compatibility failures never auto-retry.
          fail(record, code: NamuError.wrap(error, fallback: NamuError.fileDamaged).code)
        }
      }
    }
  }

  /// Runs off the service queue. Order is fixed by DL-010: exact length →
  /// streaming SHA-256 → structural GGUF check. The inference runtime's parser
  /// is never involved.
  private func verifyStagedFile(_ record: TransferRecord, store: ModelStore) throws {
    let url = try store.stagingURL(transferId: record.transferId)
    let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
    guard size == record.expectedBytes else { throw NamuError(NamuError.fileDamaged, "length mismatch") }

    let id = record.transferId
    let digest: String
    do {
      digest = try Sha256Streamer.hashFile(
        at: url,
        progress: { [weak self] hashed in
          self?.queue.async {
            self?.liveVerified[id] = hashed
            self?.publish()
          }
        },
        isCancelled: { [weak self] in
          guard let self else { return true }
          return self.queue.sync { self.cancelledVerifications.contains(id) }
        })
    } catch {
      throw NamuError(NamuError.fileDamaged, "hash aborted")
    }
    guard digest == record.artifactSha256 else { throw NamuError(NamuError.fileDamaged, "sha256 mismatch") }

    // The journaled envelope is re-verified to recover the signed architecture.
    var ctx = DescriptorContext(
      keys: config.keys, source: .bundled, appBuild: config.appBuild, runtimeBuildId: config.runtimeBuildId,
      nowMs: namuNowMs(), profile: config.profile)
    ctx.knownBad = []
    guard case .accepted(let descriptor, _) = DescriptorVerifier.verify(envelope: record.descriptorBytes, context: ctx),
          descriptor.sha256 == record.artifactSha256 else {
      throw NamuError(NamuError.signatureInvalid, "journaled descriptor")
    }
    let architecture: String
    do {
      architecture = try GGUFCheck.readArchitecture(at: url)
    } catch {
      throw NamuError(NamuError.fileDamaged, "gguf structure")
    }
    guard architecture == descriptor.architecture else {
      throw NamuError(NamuError.modelIncompatible, "architecture mismatch")
    }
  }

  // MARK: - HTTP validation

  /// Returns nil when the response is acceptable, otherwise the HTTP status
  /// (0 for a non-HTTP or off-origin response).
  private func rejectedStatus(of task: URLSessionTask) -> Int? {
    guard let origin = config.modelOrigin, let response = task.response as? HTTPURLResponse else { return 0 }
    // Background sessions follow redirects on their own; refuse the result
    // when it left MODEL_ORIGIN (DL-003).
    guard NamuBuildConfig.isSameOrigin(response.url, origin: origin) else { return 0 }
    if let encoding = response.value(forHTTPHeaderField: "Content-Encoding")?.lowercased(),
       !encoding.isEmpty, encoding != "identity" { return 0 }
    return (response.statusCode == 200 || response.statusCode == 206) ? nil : response.statusCode
  }

  private func handleRejectedResponse(_ record: TransferRecord, status: Int, task: URLSessionTask) {
    liveTasks[record.transferId] = nil
    liveCommitted[record.transferId] = 0
    var row = record
    row.committedBytes = 0
    if status == 408 || status == 429 || (500...599).contains(status) {
      let header = (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After")
      scheduleRetry(row, resumeData: nil, retryAfter: header.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) })
    } else {
      fail(row, code: NamuError.transferRetry) // other 4xx, off-origin: never auto-retried
    }
  }

  private func record(for task: URLSessionTask) -> TransferRecord? {
    guard let store, let id = task.taskDescription, let row = try? store.journal.transfer(id: id),
          row.osTaskId == String(task.taskIdentifier) else { return nil }
    return row
  }
}

// MARK: - URLSession delegate (serial, on `queue`)

extension TransferService: URLSessionDownloadDelegate {
  func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
    guard session === self.session || sessionInvalidating else { return }
    self.session = nil
    sessionInvalidating = false
    let continuations = afterInvalidation
    afterInvalidation.removeAll()
    continuations.forEach { $0() }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let handler = backgroundCompletionHandler else { return }
    backgroundCompletionHandler = nil
    DispatchQueue.main.async(execute: handler)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // DL-003: refuse redirects that leave MODEL_ORIGIN. (Background sessions
    // may follow redirects without asking; `rejectedStatus` covers that.)
    guard let origin = config.modelOrigin, NamuBuildConfig.isSameOrigin(request.url, origin: origin) else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }

  func urlSession(_ session: URLSession, taskIsWaitingForConnectivity task: URLSessionTask) {
    guard let store, var row = record(for: task), row.phase == .downloading else { return }
    row.phase = .waiting
    row.lastError = NamuError.networkWait
    try? store.journal.save(row)
    publish(force: true)
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64,
    expectedTotalBytes: Int64
  ) {
    resumedTasks.remove(downloadTask.taskIdentifier) // the OS accepted the resume data
    if let id = downloadTask.taskDescription { liveCommitted[id] = fileOffset }
  }

  func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
  ) {
    guard let store else { return }
    guard var row = record(for: downloadTask), row.phase == .downloading || row.phase == .waiting else {
      if !expectedCancellations.contains(downloadTask.taskIdentifier) {
        expectedCancellations.insert(downloadTask.taskIdentifier)
        downloadTask.cancel() // not ours any more
      }
      return
    }
    let id = row.transferId
    let now = namuNowMs()

    if validatedTasks.insert(downloadTask.taskIdentifier).inserted, let status = rejectedStatus(of: downloadTask) {
      expectedCancellations.insert(downloadTask.taskIdentifier)
      downloadTask.cancel()
      handleRejectedResponse(row, status: status, task: downloadTask)
      return
    }

    // DL-007 / T07: never accept more than the signed length.
    let announced = totalBytesExpectedToWrite
    if totalBytesWritten > row.expectedBytes || (announced != NSURLSessionTransferSizeUnknown && announced > row.expectedBytes) {
      expectedCancellations.insert(downloadTask.taskIdentifier)
      downloadTask.cancel()
      liveTasks[id] = nil
      fail(row, code: NamuError.fileDamaged)
      return
    }

    // DL-009: pause when the reserve falls below 256 MiB; checked every 2 s.
    if now - lastSpaceCheckAt >= 2000 {
      lastSpaceCheckAt = now
      if store.freeBytes() < NamuConstants.runningReserveBytes {
        row.phase = .waiting
        row.lastError = NamuError.spaceLow
        row.committedBytes = totalBytesWritten
        try? store.journal.save(row)
        publish(force: true)
        stopTask(transferId: id, produceResumeData: true) { [self] resumeData in
          if var latest = try? store.journal.transfer(id: id), latest.lastError == NamuError.spaceLow {
            latest.resumeData = resumeData
            latest.osTaskId = nil
            try? store.journal.save(latest)
          }
          publish(force: true)
        }
        return
      }
    }

    var changed = false
    if resumedTasks.remove(downloadTask.taskIdentifier) != nil, totalBytesWritten < row.committedBytes {
      // The server answered the resumed request from the start (T04): the OS
      // restarted the body, so say so instead of claiming resumed bytes.
      row.restartedFromZero = true
      changed = true
    }
    liveCommitted[id] = totalBytesWritten
    if row.phase != .downloading || row.lastError != nil || row.nextRetryAt != nil {
      row.phase = .downloading
      row.lastError = nil
      row.nextRetryAt = nil
      changed = true
    }
    if row.retryCount != 0 { // progress resets the consecutive-failure counter
      row.retryCount = 0
      changed = true
    }
    if changed || now - (lastProgressJournalAt[id] ?? 0) >= 2000 {
      lastProgressJournalAt[id] = now
      row.committedBytes = totalBytesWritten
      try? store.journal.save(row)
    }
    publish(force: changed)
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    // The temporary file disappears when this callback returns, so everything
    // below is synchronous (DL-005).
    guard let store, var row = record(for: downloadTask), row.phase == .downloading || row.phase == .waiting else {
      return
    }
    let id = row.transferId
    liveTasks[id] = nil
    expectedCancellations.insert(downloadTask.taskIdentifier) // completion is handled here

    if let status = rejectedStatus(of: downloadTask) {
      handleRejectedResponse(row, status: status, task: downloadTask)
      return
    }
    do {
      let staging = try store.stagingURL(transferId: id)
      try? FileManager.default.removeItem(at: staging)
      if rename(location.path, staging.path) != 0 {
        // Different volume: a copy needs B more bytes (DL-009).
        guard errno == EXDEV else { throw DurableFile.IOFailure(operation: "rename-staging", code: errno) }
        guard store.freeBytes() >= row.expectedBytes + NamuConstants.runningReserveBytes else {
          fail(row, code: NamuError.spaceLow)
          return
        }
        try FileManager.default.moveItem(at: location, to: staging)
      }
      try? FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: staging.path)
      let size = (try FileManager.default.attributesOfItem(atPath: staging.path)[.size] as? NSNumber)?.int64Value ?? 0
      row.stagedFilename = staging.lastPathComponent
      row.committedBytes = size
      row.osTaskId = nil
      row.resumeData = nil
      row.nextRetryAt = nil
      row.lastError = nil
      row.phase = .verifying
      try store.journal.save(row)
      liveCommitted[id] = size
      publish(force: true)
      startVerification(row)
    } catch {
      fail(row, code: NamuError.storageWriteFailed)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    validatedTasks.remove(task.taskIdentifier)
    resumedTasks.remove(task.taskIdentifier)
    if expectedCancellations.remove(task.taskIdentifier) != nil { return } // initiated by us
    guard let error = error as NSError?, let row = record(for: task),
          row.phase == .downloading || row.phase == .waiting else { return }
    liveTasks[row.transferId] = nil
    let resumeData = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data

    if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled {
      // Cancelled by the system: force-quit, background refresh disabled or
      // resource pressure (T12). Keep what can be resumed; the user decides.
      var kept = row
      kept.resumeData = resumeData ?? row.resumeData
      fail(kept, code: NamuError.transferRetry, keepResumeData: true)
      return
    }
    // Transient transport failure reported by the task → DL-007 back-off.
    scheduleRetry(row, resumeData: resumeData, retryAfter: nil)
  }
}

// MARK: - Update descriptor fetch

/// One small foreground GET of `releases/stable.json` (SIG-005): ephemeral, no
/// cookies or cache, same-origin redirects only, body capped at 64 KiB.
private final class DescriptorFetcher: NSObject, URLSessionDataDelegate {
  private let origin: String
  private let completion: (Result<Data, NamuError>) -> Void
  private var body = Data()
  private var finished = false

  private init(origin: String, completion: @escaping (Result<Data, NamuError>) -> Void) {
    self.origin = origin
    self.completion = completion
  }

  static func fetch(url: URL, origin: String, completion: @escaping (Result<Data, NamuError>) -> Void) {
    let fetcher = DescriptorFetcher(origin: origin, completion: completion)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 60
    // The session retains its delegate until it is invalidated.
    let session = URLSession(configuration: configuration, delegate: fetcher, delegateQueue: nil)
    var request = URLRequest(url: url)
    request.httpShouldHandleCookies = false
    session.dataTask(with: request).resume()
    session.finishTasksAndInvalidate()
  }

  private func finish(_ result: Result<Data, NamuError>) {
    guard !finished else { return }
    finished = true
    completion(result)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(NamuBuildConfig.isSameOrigin(request.url, origin: origin) ? request : nil)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
          NamuBuildConfig.isSameOrigin(http.url, origin: origin) else {
      finish(.failure(NamuError(NamuError.transferRetry, "descriptor status")))
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    body.append(data)
    if body.count > DescriptorVerifier.maxEnvelopeBytes {
      finish(.failure(NamuError(NamuError.signatureInvalid, "envelope size")))
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if error != nil {
      finish(.failure(NamuError(NamuError.networkWait, "descriptor fetch")))
    } else {
      finish(.success(body))
    }
  }
}
