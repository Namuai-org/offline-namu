import React, {useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {useNamuTheme} from '../theme';
import {radii, sizes, spacing} from '../tokens';
import {NamuText} from './NamuText';

export interface NamuButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'text' | 'destructive';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * DS-005: disabled, pressed, loading and focused states; 48 px minimum touch
 * target; no fixed height so scaled text never clips (DS-002).
 */
export const NamuButton = React.forwardRef<React.ElementRef<typeof Pressable>, NamuButtonProps>(function NamuButton(
  {label, onPress, variant = 'primary', icon, disabled = false, loading = false, accessibilityHint, testID, style},
  ref,
) {
  const {colors} = useNamuTheme();
  const [focused, setFocused] = useState(false);
  const inactive = disabled || loading;

  const background =
    variant === 'primary' ? colors.action : variant === 'destructive' ? colors.error : 'transparent';
  const foreground =
    variant === 'primary' ? colors.onAction
    : variant === 'destructive' ? colors.surface
    : colors.link;
  const borderColor = variant === 'secondary' ? colors.outline : 'transparent';

  return (
    <Pressable
      ref={ref}
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{disabled: inactive, busy: loading}}
      style={({pressed}) => [
        styles.base,
        {
          backgroundColor: background,
          borderColor: focused ? colors.focus : borderColor,
          borderWidth: focused ? 2 : variant === 'secondary' ? 1 : 0,
          opacity: inactive ? 0.45 : pressed ? 0.8 : 1,
        },
        style,
      ]}>
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator size="small" color={foreground} />
        ) : icon ? (
          <NamuIcon name={icon} color={foreground} />
        ) : null}
        <NamuText variant="body" weight="medium" style={{color: foreground, flexShrink: 1}} align="center">
          {label}
        </NamuText>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: {
    minHeight: sizes.touchTarget,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    justifyContent: 'center',
  },
  content: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm},
});
