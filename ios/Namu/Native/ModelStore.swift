import Foundation

enum InstallState: String {
  case absent, installed, needsRepair
}

/// `pending-activation.json`, written durably before the self-test (DL-012).
struct PendingActivationMarker: Codable, Equatable {
  var transferId: String
  var artifactId: String
  var startedAt: Int64
}

/// Owns the on-disk layout under `Library/Application Support/NamuModels`
/// (DL-008, contract §3), the active pointer, the pending-activation marker,
/// startup reconciliation (§6.4) and retention (DL-013). No networking here,
/// so everything in this file is unit-testable against a temporary root.
final class ModelStore {
  static let retentionInterval: Int64 = 7 * 24 * 3600 * 1000
  static let retentionSessions = 3

  let root: URL
  private(set) var journal: TransferJournal
  private let bundledKnownBad: Set<String>
  private let fm = FileManager.default

  private(set) var pointer: ActivePointer?
  private(set) var installState: InstallState = .absent
  /// DL-013: artifact currently mapped by the inference runtime. Process
  /// scoped on purpose: a dead process holds no runtime reference.
  var runtimeReference: String?

  static func defaultRoot() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("NamuModels", isDirectory: true)
  }

  init(root: URL, bundledKnownBad: Set<String>) throws {
    self.root = root
    self.bundledKnownBad = bundledKnownBad
    try ModelStore.prepareLayout(root: root)
    journal = try TransferJournal(url: ModelStore.journalURL(root: root))
  }

  // MARK: - Layout

  static func journalURL(root: URL) -> URL {
    root.appendingPathComponent("journal/transfer-journal.sqlite")
  }

  var stagingDirectory: URL { root.appendingPathComponent("staging", isDirectory: true) }
  var releasesDirectory: URL { root.appendingPathComponent("releases", isDirectory: true) }
  var pointerURL: URL { root.appendingPathComponent("active.json") }
  var markerURL: URL { root.appendingPathComponent("pending-activation.json") }
  private var pointerStore: ActivePointerStore { ActivePointerStore(url: pointerURL) }

  /// Paths use app-generated IDs only (DL-008); both inputs are validated.
  func stagingURL(transferId: String) throws -> URL {
    guard NamuPattern.isUUID(transferId) else { throw NamuError(NamuError.invalidState, "transfer id") }
    return stagingDirectory.appendingPathComponent("\(transferId).download")
  }

  func releaseDirectory(artifactId: String) throws -> URL {
    guard NamuPattern.isSha256Hex(artifactId) else { throw NamuError(NamuError.notFound, "artifact id") }
    return releasesDirectory.appendingPathComponent(artifactId, isDirectory: true)
  }

  func releaseFileURL(artifactId: String) throws -> URL {
    try releaseDirectory(artifactId: artifactId).appendingPathComponent("model.gguf")
  }

  private static func prepareLayout(root: URL) throws {
    let fm = FileManager.default
    for directory in [root, root.appendingPathComponent("journal"), root.appendingPathComponent("staging"),
                      root.appendingPathComponent("releases")] {
      try fm.createDirectory(at: directory, withIntermediateDirectories: true)
      // SEC-001: background transfers must finish after first unlock.
      try? fm.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
    }
    // SEC-001 / DL-008: weights, staging and journal never enter backups.
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var mutableRoot = root
    try mutableRoot.setResourceValues(values)
  }

  // MARK: - Space (DL-009)

  func freeBytes() -> Int64 {
    if let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
       let capacity = values.volumeAvailableCapacityForImportantUsage, capacity > 0 {
      return capacity
    }
    let attributes = try? fm.attributesOfFileSystem(forPath: root.path)
    return (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
  }

  // MARK: - Known-bad digests

  func knownBad() -> Set<String> {
    bundledKnownBad.union((try? journal.badDigests()) ?? [])
  }

  // MARK: - Releases

  func releaseIsIntact(artifactId: String, bytes: Int64) -> Bool {
    // DL-014: existence and exact length only; no rehash on every launch.
    guard let url = try? releaseFileURL(artifactId: artifactId),
          let attributes = try? fm.attributesOfItem(atPath: url.path),
          let size = attributes[.size] as? NSNumber else { return false }
    return size.int64Value == bytes
  }

  func isReferencedByPointer(_ artifactId: String) -> Bool {
    pointer?.active.artifactId == artifactId || pointer?.previous?.artifactId == artifactId
  }

  /// Contract §6.4 step 4. Only called after length, SHA-256 and the GGUF
  /// structure check passed, so everything under releases/ is verified.
  func installVerifiedFile(from staging: URL, artifactId: String, expectedBytes: Int64) throws {
    let directory = try releaseDirectory(artifactId: artifactId)
    let target = directory.appendingPathComponent("model.gguf")
    // An intact release the pointer references is immutable; a damaged one is
    // being replaced by this repair download.
    guard !(isReferencedByPointer(artifactId) && releaseIsIntact(artifactId: artifactId, bytes: expectedBytes)) else {
      throw NamuError(NamuError.invalidState, "release already active")
    }
    if fm.fileExists(atPath: directory.path) { try removeTree(directory) }
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    // rename(2) fails with EXDEV instead of silently copying 2 GB (DL-008).
    guard rename(staging.path, target.path) == 0 else {
      let code = errno
      try? fm.removeItem(at: directory)
      throw DurableFile.IOFailure(operation: "rename-release", code: code)
    }
    // Installed files are immutable to normal application operations.
    chmod(target.path, 0o444)
    try? fm.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
    try DurableFile.syncDirectory(directory)
    try DurableFile.syncDirectory(releasesDirectory)
  }

  func removeRelease(artifactId: String) throws {
    guard !isReferencedByPointer(artifactId) else {
      throw NamuError(NamuError.invalidState, "release is referenced by the active pointer")
    }
    guard runtimeReference != artifactId else { throw NamuError(NamuError.engineBusy, "runtime reference") }
    let directory = try releaseDirectory(artifactId: artifactId)
    if fm.fileExists(atPath: directory.path) {
      try removeTree(directory)
      try DurableFile.syncDirectory(releasesDirectory)
    }
  }

  func removeStagingFile(transferId: String) {
    if let url = try? stagingURL(transferId: transferId) { try? fm.removeItem(at: url) }
  }

  /// Release files are 0444; make the tree writable before unlinking.
  private func removeTree(_ directory: URL) throws {
    if let items = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
      for item in items { chmod(item.path, 0o644) }
    }
    try fm.removeItem(at: directory)
  }

  // MARK: - Pending-activation marker (DL-012)

  func writeMarker(_ marker: PendingActivationMarker) throws {
    try DurableFile.write(try JSONEncoder().encode(marker), to: markerURL)
  }

  func readMarker() -> PendingActivationMarker? {
    guard let data = try? Data(contentsOf: markerURL) else { return nil }
    return try? JSONDecoder().decode(PendingActivationMarker.self, from: data)
  }

  func deleteMarker() throws {
    try DurableFile.remove(markerURL)
  }

  // MARK: - Activation (contract §6.4 step 6)

  /// Atomic active-pointer replacement followed by the journal commit.
  func activate(transfer: TransferRecord, now: Int64 = namuNowMs()) throws {
    guard releaseIsIntact(artifactId: transfer.artifactSha256, bytes: transfer.expectedBytes) else {
      throw NamuError(NamuError.fileDamaged, "candidate release missing")
    }
    let old = pointer
    let entry = ActiveEntry(
      artifactId: transfer.artifactSha256, version: transfer.artifactVersion, bytes: transfer.expectedBytes,
      sha256: transfer.artifactSha256, activatedAt: now)
    var previous: ActiveEntry?
    if let oldActive = old?.active {
      // DL-013: exactly one previous version is retained. Re-activating the
      // same artifact (repair) keeps whatever previous version existed.
      let candidate = oldActive.artifactId == entry.artifactId ? old?.previous : oldActive
      if let candidate, candidate.artifactId != entry.artifactId,
         releaseIsIntact(artifactId: candidate.artifactId, bytes: candidate.bytes) {
        previous = candidate
      }
    }
    let next = ActivePointer(active: entry, previous: previous, trial: TrialState(startedAt: now, successfulSessions: 0))
    try pointerStore.write(next)
    pointer = next
    installState = .installed

    // The journal only mirrors the pointer; failures here are repaired by the
    // next reconciliation and must not undo a committed activation.
    try? mirrorPointer()
    var record = transfer
    record.phase = .installed
    record.lastError = nil
    record.nextRetryAt = nil
    try? journal.save(record)
    try? deleteMarker()

    for stale in [old?.active, old?.previous].compactMap({ $0 }) where !isReferencedByPointer(stale.artifactId) {
      dropUnreferencedArtifact(stale.artifactId)
    }
  }

  /// `activate(pass=false)`: quarantine the candidate, keep the old pointer.
  func failActivation(transfer: TransferRecord, code: String) throws {
    try quarantine(artifactId: transfer.artifactSha256, reason: code)
    var record = transfer
    record.phase = .failed
    record.lastError = code
    try journal.save(record)
    try deleteMarker()
  }

  private func quarantine(artifactId: String, reason: String) throws {
    guard !isReferencedByPointer(artifactId) else { return }
    try journal.markBad(sha256: artifactId, reason: reason)
    try? removeRelease(artifactId: artifactId)
  }

  private func dropUnreferencedArtifact(_ artifactId: String) {
    guard runtimeReference != artifactId else { return } // collected by a later sweep
    try? removeRelease(artifactId: artifactId)
    if let row = try? journal.transfer(artifactSha256: artifactId), row.phase == .installed {
      try? journal.deleteTransfer(id: row.transferId)
    }
  }

  private func mirrorPointer() throws {
    let json = try pointer.map { String(decoding: try $0.encoded(), as: UTF8.self) }
    try journal.setMeta(TransferJournal.MetaKey.activeMirror, json)
  }

  // MARK: - Restore and retention (DL-013)

  var canRestorePrevious: Bool {
    guard let previous = pointer?.previous else { return false }
    return releaseIsIntact(artifactId: previous.artifactId, bytes: previous.bytes)
      && !knownBad().contains(previous.sha256)
  }

  enum RestoreMode {
    /// User tapped "Restore previous version": a true swap, nothing is deleted.
    case userSwap
    /// Repair found the active file missing/corrupt: drop it, digest stays good.
    case replaceDamaged
    /// Automatic rollback after a failed trial: the abandoned digest is marked bad.
    case failedTrial
  }

  /// Atomically swaps the pointer back to the previous artifact (DL-013).
  func restorePrevious(mode: RestoreMode, now: Int64 = namuNowMs()) throws {
    guard let current = pointer, let previous = current.previous, canRestorePrevious else {
      throw NamuError(NamuError.invalidState, "no previous version")
    }
    if mode != .userSwap, runtimeReference == current.active.artifactId {
      throw NamuError(NamuError.engineBusy, "runtime reference")
    }
    var restored = previous
    restored.activatedAt = now
    let next = ActivePointer(
      active: restored, previous: mode == .userSwap ? current.active : nil,
      trial: TrialState(startedAt: now, successfulSessions: 0))
    try pointerStore.write(next)
    pointer = next
    installState = .installed
    try? mirrorPointer()
    if mode == .failedTrial {
      try? journal.markBad(sha256: current.active.sha256, reason: "failed-trial")
    }
    if mode != .userSwap {
      dropUnreferencedArtifact(current.active.artifactId)
    }
  }

  func noteSuccessfulSession(now: Int64 = namuNowMs()) throws {
    guard var next = pointer else { return }
    next.trial.successfulSessions = min(next.trial.successfulSessions + 1, 1_000_000)
    try pointerStore.write(next)
    pointer = next
    try? mirrorPointer()
    applyRetention(now: now)
  }

  /// Deletes `previous` once seven days AND three successful foreground
  /// sessions have passed, and only while the runtime does not map it.
  func applyRetention(now: Int64 = namuNowMs()) {
    guard var next = pointer, let previous = next.previous else { return }
    guard now - next.trial.startedAt >= ModelStore.retentionInterval,
          next.trial.successfulSessions >= ModelStore.retentionSessions,
          runtimeReference != previous.artifactId else { return }
    next.previous = nil
    guard (try? pointerStore.write(next)) != nil else { return }
    pointer = next
    try? mirrorPointer()
    dropUnreferencedArtifact(previous.artifactId)
  }

  /// Used by repair (DL-014) when the active file is missing or corrupt and
  /// no previous version can take over: the pointer stays, state needs repair.
  func markActiveDamaged() {
    guard let active = pointer?.active else { return }
    if let url = try? releaseFileURL(artifactId: active.artifactId), fm.fileExists(atPath: url.path) {
      chmod(url.path, 0o644)
      try? fm.removeItem(at: url)
    }
    installState = .needsRepair
  }

  // MARK: - Removal (S07, SEC-006)

  /// Removes every model file and transfer row. Sequence and bad-digest
  /// memory survive so replayed metadata stays rejected (SIG-003).
  func removeAllModels() throws {
    guard runtimeReference == nil else { throw NamuError(NamuError.engineBusy, "runtime reference") }
    for var row in (try? journal.allTransfers()) ?? [] {
      row.phase = .removing
      try? journal.save(row)
    }
    try pointerStore.clear()
    pointer = nil
    installState = .absent
    try? deleteMarker()
    try? mirrorPointer()
    try finishRemoval()
  }

  private func finishRemoval() throws {
    for directory in [releasesDirectory, stagingDirectory] {
      for item in (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
        var isDirectory: ObjCBool = false
        if fm.fileExists(atPath: item.path, isDirectory: &isDirectory), isDirectory.boolValue {
          try removeTree(item)
        } else {
          try fm.removeItem(at: item)
        }
      }
    }
    try journal.deleteAllTransfers()
  }

  /// SEC-006: removes journal, staging, releases and pointer, then recreates
  /// an empty layout so the service keeps working (back to S01).
  func deleteEverything() throws {
    guard runtimeReference == nil else { throw NamuError(NamuError.engineBusy, "runtime reference") }
    journal.close()
    if let items = try? fm.contentsOfDirectory(at: releasesDirectory, includingPropertiesForKeys: nil) {
      for item in items { try? removeTree(item) }
    }
    try fm.removeItem(at: root)
    pointer = nil
    installState = .absent
    try ModelStore.prepareLayout(root: root)
    journal = try TransferJournal(url: ModelStore.journalURL(root: root))
  }

  // MARK: - Startup reconciliation (DL-012, DL-014, contract §6.4)

  /// Derives installed state from the pointer and repairs the journal mirror.
  /// Runs before the first snapshot is answered; never rehashes weights.
  func reconcile() throws {
    pointer = pointerStore.load() // a leftover .tmp is discarded, never promoted

    // Marker present → the process died during the self-test.
    if fm.fileExists(atPath: markerURL.path) {
      if let marker = readMarker() {
        try settleInterruptedSelfTest(artifactId: marker.artifactId, transferId: marker.transferId)
      } else {
        for row in try journal.allTransfers() where row.phase == .selfTesting {
          try settleInterruptedSelfTest(artifactId: row.artifactSha256, transferId: row.transferId)
        }
      }
      try deleteMarker()
    }

    if let active = pointer?.active {
      installState = releaseIsIntact(artifactId: active.artifactId, bytes: active.bytes) ? .installed : .needsRepair
    } else {
      installState = .absent
    }
    try mirrorPointer()

    for var row in try journal.allTransfers() {
      let intact = releaseIsIntact(artifactId: row.artifactSha256, bytes: row.expectedBytes)
      switch row.phase {
      case .installed:
        if isReferencedByPointer(row.artifactSha256) { continue }
        if intact {
          row.phase = .staged // verified release without pointer: staged, not installed
          try journal.save(row)
        } else {
          try journal.deleteTransfer(id: row.transferId)
        }
      case .staged, .selfTesting:
        if pointer?.active.artifactId == row.artifactSha256 {
          row.phase = .installed
        } else if intact {
          row.phase = .staged
        } else {
          row.phase = .failed
          row.lastError = row.lastError ?? NamuError.fileDamaged
        }
        try journal.save(row)
      case .verifying:
        // Crash between the release rename and the journal commit.
        if intact {
          row.phase = .staged
          row.verifiedBytes = row.expectedBytes
          try journal.save(row)
        }
      case .removing:
        removeStagingFile(transferId: row.transferId)
        if !isReferencedByPointer(row.artifactSha256) { try? removeRelease(artifactId: row.artifactSha256) }
        try journal.deleteTransfer(id: row.transferId)
      default:
        break // network phases are reconciled against URLSession tasks by TransferService
      }
    }

    try sweepOrphans()
    applyRetention()
  }

  private func settleInterruptedSelfTest(artifactId: String, transferId: String) throws {
    var row = try journal.transfer(id: transferId)
    if row == nil { row = try journal.transfer(artifactSha256: artifactId) }
    if pointer?.active.artifactId == artifactId {
      // The pointer was replaced before the crash: activation is committed.
      if var row { row.phase = .installed; row.lastError = nil; try journal.save(row) }
      return
    }
    try quarantine(artifactId: artifactId, reason: "self-test-crash")
    if var row {
      row.phase = .failed
      row.lastError = NamuError.modelLoadFailed
      try journal.save(row)
    }
  }

  /// Files that neither the pointer nor the journal knows are never trusted.
  private func sweepOrphans() throws {
    let rows = try journal.allTransfers()
    // Failed rows never keep a release alive (their candidate was quarantined).
    let holdsRelease: Set<TransferPhase> = [.verifying, .staged, .selfTesting, .installed]
    let knownArtifacts = Set(rows.filter { holdsRelease.contains($0.phase) }.map(\.artifactSha256))
    for item in (try? fm.contentsOfDirectory(at: releasesDirectory, includingPropertiesForKeys: nil)) ?? [] {
      let name = item.lastPathComponent
      if isReferencedByPointer(name) || knownArtifacts.contains(name) { continue }
      try? removeTree(item)
    }
    let knownStaging = Set(rows.map { "\($0.transferId).download" })
    for item in (try? fm.contentsOfDirectory(at: stagingDirectory, includingPropertiesForKeys: nil)) ?? []
    where !knownStaging.contains(item.lastPathComponent) {
      try? fm.removeItem(at: item)
    }
  }
}
