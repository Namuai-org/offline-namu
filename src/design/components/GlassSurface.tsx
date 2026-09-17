import React from 'react';
import {Platform, StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {useNamuTheme} from '../theme';
import {radii} from '../tokens';

type GlassBackend = React.ComponentType<{tone?: string; style?: StyleProp<ViewStyle>}>;
let backend: GlassBackend | null = null;

/**
 * The composition root registers the native glass view (iOS). The design
 * system never imports infrastructure itself (ARC-001); without a backend —
 * Android, tests — the surface uses the near-opaque token fallback.
 */
export function registerGlassBackend(component: GlassBackend | null): void {
  backend = component;
}

/**
 * Apple-style glass panel: system material blur, a warm Namu tint, a hairline
 * light edge and a soft shadow. Content keeps DS-004 contrast because the tint
 * stays between `surface` and `background`, both of which are checked.
 * Reduce Transparency is honoured by the system material itself.
 */
export function GlassSurface({
  children,
  radius = radii.surface,
  style,
  contentStyle,
  floating = false,
  testID,
}: {
  children?: React.ReactNode;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  /** Adds the soft drop shadow used by floating bars. */
  floating?: boolean;
  testID?: string;
}): React.JSX.Element {
  const {colors, dark} = useNamuTheme();
  const Backend = Platform.OS === 'ios' ? backend : null;
  return (
    <View
      testID={testID}
      style={[
        floating
          ? {
              shadowColor: '#1C1410',
              shadowOpacity: dark ? 0.45 : 0.14,
              shadowRadius: 18,
              shadowOffset: {width: 0, height: 8},
              elevation: 6,
            }
          : null,
        {borderRadius: radius},
        style,
      ]}>
      <View
        style={[
          {
            borderRadius: radius,
            overflow: 'hidden',
            borderWidth: StyleSheet.hairlineWidth * 2,
            borderColor: colors.glassEdge,
            backgroundColor: Backend ? 'transparent' : colors.glassFallback,
          },
          contentStyle,
        ]}>
        {Backend ? (
          <>
            <Backend tone={dark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, {backgroundColor: colors.glassTint}]} />
          </>
        ) : null}
        {children}
      </View>
    </View>
  );
}
