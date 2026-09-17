import {ModelInstallController} from '../../src/domain/model/ModelInstallController';
import {evaluateEligibility, hasSpaceFor, requiredAdditionalBytes} from '../../src/domain/model/eligibility';
import {SnapshotFormatError, parseDescriptorSummary, parseSnapshot} from '../../src/domain/model/transferTypes';
import {FAKE_BYTES, FakeTransferService} from '../support/fakeAdapters';
import {makeHarness, sleep, waitForIdle, type Harness} from '../support/controllerHarness';

const GIB = 1024 * 1024 * 1024;

describe('DEV-002 / DL-009 eligibility and space', () => {
  const base = {physicalMemoryBytes: 5_800_000_000, logicalCpuCount: 8, freeDiskBytes: 10e9, osSupported: true, abiSupported: true, metalSupported: true, thermalApiAvailable: true};
  it('requires at least 5,000,000,000 bytes of reported memory and offers no 4 GB mode', () => {
    expect(evaluateEligibility(base, 'android')).toEqual({eligible: true, reasons: []});
    expect(evaluateEligibility({...base, physicalMemoryBytes: 4_999_999_999}, 'android').reasons).toEqual(['memory']);
    expect(evaluateEligibility({...base, physicalMemoryBytes: 3_700_000_000}, 'ios').eligible).toBe(false);
  });
  it('rejects unsupported OS/ABI and iOS without Metal (no CPU fallback, DEV-004)', () => {
    expect(evaluateEligibility({...base, osSupported: false, abiSupported: false}, 'android').reasons).toEqual(['os', 'abi']);
    expect(evaluateEligibility({...base, metalSupported: false}, 'ios').reasons).toEqual(['metal']);
    expect(evaluateEligibility({...base, metalSupported: false}, 'android').eligible).toBe(true);
  });
  it('needs (B − P) + 1 GiB and never counts installed bytes twice', () => {
    expect(requiredAdditionalBytes(FAKE_BYTES, 0)).toBe(FAKE_BYTES + GIB);
    expect(requiredAdditionalBytes(FAKE_BYTES, 1_000_000_000)).toBe(FAKE_BYTES - 1_000_000_000 + GIB);
    expect(requiredAdditionalBytes(FAKE_BYTES, FAKE_BYTES + 5)).toBe(GIB);
    expect(hasSpaceFor(FAKE_BYTES + GIB - 1, FAKE_BYTES, 0)).toBe(false);
    expect(hasSpaceFor(FAKE_BYTES + GIB, FAKE_BYTES, 0)).toBe(true);
  });
});

describe('native snapshot validation (ARC-003)', () => {
  it('parses a full snapshot and rejects malformed ones instead of guessing', () => {
    const transfer = new FakeTransferService();
    transfer.installNow();
    const parsed = parseSnapshot(JSON.stringify(transfer.snapshotValue));
    expect(parsed.install.state).toBe('installed');
    expect(() => parseSnapshot('not json')).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot(JSON.stringify({install: {state: 'ready'}}))).toThrow(SnapshotFormatError);
    expect(() =>
      parseSnapshot(JSON.stringify({install: {state: 'installed', active: {artifactId: 'x', version: '1', bytes: 1, sha256: 'short'}}})),
    ).toThrow(SnapshotFormatError);
    expect(() =>
      parseSnapshot(JSON.stringify({install: {state: 'absent'}, transfer: {transferId: 't', artifactVersion: 'v', artifactSha256: 's', phase: 'exploding', expectedBytes: 1, committedBytes: 0}})),
    ).toThrow(SnapshotFormatError);
  });
  it('drops unknown error codes and treats an unreadable descriptor summary as invalid', () => {
    const parsed = parseSnapshot(
      JSON.stringify({install: {state: 'absent'}, transfer: {transferId: 't', artifactVersion: 'v', artifactSha256: 's', phase: 'failed', expectedBytes: 1, committedBytes: 0, errorCode: '/data/user/0/secret/path'}}),
    );
    expect(parsed.transfer?.errorCode).toBeNull(); // paths can never reach error UI
    expect(parseDescriptorSummary('{')).toMatchObject({valid: false, errorCode: 'SIGNATURE_INVALID'});
  });
});

describe('DL-010/011 foreground self-test and activation', () => {
  let h: Harness;
  let transfer: FakeTransferService;
  let install: ModelInstallController;
  const marker: string[] = [];

  beforeEach(async () => {
    h = await makeHarness();
    transfer = new FakeTransferService();
    marker.length = 0;
    install = new ModelInstallController({
      transfer,
      engine: h.engine,
      ownership: h.ownership,
      chat: () => h.controller,
      loadMarker: {set: async () => void marker.push('set'), clear: async () => void marker.push('clear')},
      diagnostics: {record: () => undefined},
    });
    await install.start();
  });
  afterEach(async () => {
    install.stop();
    await h.t.db.close();
  });

  async function stage(isUpdate: boolean) {
    await transfer.start(isUpdate ? 'update' : 'bundled', false);
    transfer.setTransfer({phase: 'staged', committedBytes: FAKE_BYTES, verifiedBytes: FAKE_BYTES});
  }

  it('refuses when nothing is staged', async () => {
    expect(await install.finishStagedInstall()).toEqual({ok: false, reason: 'not-staged'});
    expect(transfer.calls).not.toContain('beginSelfTest:t1');
  });

  it('marks pending activation, tests, unloads the candidate and activates', async () => {
    await stage(false);
    expect(await install.finishStagedInstall()).toEqual({ok: true});
    const order = transfer.calls.filter(c => c.startsWith('beginSelfTest') || c.startsWith('activate'));
    expect(order).toEqual(['beginSelfTest:t1', 'activate:t1:true:']);
    expect(marker).toEqual(['set', 'clear']);
    expect(h.engine.state()).toBe('unloaded');
    expect(install.installedArtifact()).not.toBeNull();
  });

  it('T11: an update staged while answering stops the answer first; contexts are never held together', async () => {
    transfer.installNow();
    await install.refresh();
    h.engine.script.tokenDelayMs = 5;
    await h.controller.send(null, 'long answer please');
    await sleep(12);
    await stage(true);
    // Staging alone changes nothing: the old model keeps answering.
    expect(h.controller.getState().active).not.toBeNull();
    expect(transfer.calls).not.toContain('beginSelfTest:t1');

    const result = await install.finishStagedInstall(); // the explicit idle transition
    expect(result).toEqual({ok: true});
    await waitForIdle(h.controller);
    const events = h.engine.events;
    const firstUnload = events.indexOf('unload');
    const candidateLoad = events.lastIndexOf(events.filter(e => e.startsWith('load:')).pop()!);
    expect(firstUnload).toBeGreaterThan(-1);
    expect(firstUnload).toBeLessThan(candidateLoad); // old context released before the new one loads
  });

  it('keeps the old pointer when the self-test fails and never leaves the candidate loaded', async () => {
    transfer.installNow();
    await install.refresh();
    const before = install.installedArtifact();
    h.engine.script.selfTestPasses = false;
    await stage(true);
    expect(await install.finishStagedInstall()).toEqual({ok: false, reason: 'self-test-failed'});
    expect(transfer.calls).toContain('activate:t1:false:MODEL_LOAD_FAILED');
    expect(h.engine.state()).toBe('unloaded');
    expect(install.installedArtifact() ?? before).toEqual(before);
  });

  it('does not start a self-test when the running answer cannot be stopped (INF-006)', async () => {
    h.engine.script.tokenDelayMs = 5;
    h.engine.script.neverAcknowledgeCancel = true;
    transfer.installNow();
    await install.refresh();
    await h.controller.send(null, 'q');
    await sleep(12);
    await stage(true);
    const pending = install.finishStagedInstall();
    await sleep(12);
    h.timers.advance(5000);
    expect(await pending).toEqual({ok: false, reason: 'shutdown-unconfirmed'});
    expect(transfer.calls).not.toContain('beginSelfTest:t1');
  });
});
