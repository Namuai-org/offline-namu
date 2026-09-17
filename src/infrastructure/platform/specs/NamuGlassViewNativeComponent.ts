import type {HostComponent, ViewProps} from 'react-native';
import {codegenNativeComponent} from 'react-native';

/**
 * Apple-style glass backdrop (iOS only). A leaf view that fills its parent
 * with the system material: Liquid Glass (`UIGlassEffect`) on iOS 26+, a
 * system thin material blur on iOS 17–25. The system itself honours Reduce
 * Transparency. Android has no equivalent here and uses the opaque token
 * fallback in src/design/components/GlassSurface.tsx.
 */
export interface NativeProps extends ViewProps {
  /** 'light' | 'dark' — follows the Namu theme, not the OS setting. */
  tone?: string;
}

export default codegenNativeComponent<NativeProps>('NamuGlassView', {
  excludedPlatforms: ['android'],
}) as HostComponent<NativeProps>;
