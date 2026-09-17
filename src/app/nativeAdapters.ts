import {AccessibilityInfo, Platform} from 'react-native';
import {resolveParameters} from '../domain/inference/productionConfig';
import {OpSqliteFactory} from '../infrastructure/db/OpSqliteDriver';
import {LlamaRnEngine} from '../infrastructure/inference/LlamaRnEngine';
import {FakeInferenceEngine} from '../infrastructure/inference/fake/FakeInferenceEngine';
import {NativeDeviceService} from '../infrastructure/platform/NativeDeviceService';
import {NativeExportService} from '../infrastructure/platform/NativeExportService';
import {NativeTransferService} from '../infrastructure/platform/NativeTransferService';
import {BUILD_FLAGS} from './buildFlags';
import {registerGlassBackend} from '../design/components/GlassSurface';
import NamuGlassView from '../infrastructure/platform/specs/NamuGlassViewNativeComponent';
import type {PlatformAdapters} from './services';

/** Anything smaller is a development fixture, not a language model. */
const REAL_MODEL_MIN_BYTES = 500 * 1024 * 1024;

/** Production wiring of native services. */
export function nativeAdapters(): PlatformAdapters {
  // Apple-style glass is an iOS system material; Android keeps the token fallback.
  registerGlassBackend(Platform.OS === 'ios' ? NamuGlassView : null);
  return {
    device: new NativeDeviceService(),
    transfer: new NativeTransferService(),
    createExporter: directory => new NativeExportService(directory),
    sqlite: new OpSqliteFactory(),
    createEngine: async ({info, logicalCpuCount, transfer, diagnostics}) => {
      if (info.isInternalBuild && info.isSimulator && !BUILD_FLAGS.realEngineOnSimulator) {
        // DEV-001: simulators run functional UI journeys against a small fixture
        // GGUF, which no runtime can load, so they get the scripted engine. An
        // internal build bundled with a real model descriptor loads the real one.
        const bundled = await transfer.bundledDescriptor().catch(() => null);
        if ((bundled?.bytes ?? 0) < REAL_MODEL_MIN_BYTES) {
          const fake = new FakeInferenceEngine();
          fake.script.tokenDelayMs = 40;
          fake.script.loadDelayMs = 600;
          return fake;
        }
      }
      const platform = Platform.OS === 'ios' ? 'ios' : 'android';
      return new LlamaRnEngine({
        platform,
        parameters: resolveParameters(platform, logicalCpuCount),
        resolveArtifactPath: id => transfer.resolveArtifactPath(id),
        setRuntimeReference: id => transfer.setRuntimeReference(id),
        allowCpuOnIosSimulator: info.isInternalBuild && info.isSimulator,
        diagnostics,
      });
    },
    announce: message => AccessibilityInfo.announceForAccessibility(message),
  };
}
