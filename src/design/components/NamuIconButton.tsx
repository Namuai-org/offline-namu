import React, {useState} from 'react';
import {Pressable, type StyleProp, type ViewStyle} from 'react-native';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {useNamuTheme} from '../theme';
import {sizes} from '../tokens';

/** DS-002: 24 px glyph inside a 48 px touch area; always has an accessible name. */
export const NamuIconButton = React.forwardRef<
  React.ElementRef<typeof Pressable>,
  {
    icon: IconName;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    tone?: 'primary' | 'action' | 'error' | 'secondary';
    /** 36 px visual with a 20 px glyph; hit slop keeps the 48 px touch target (DS-002). */
    compact?: boolean;
    testID?: string;
    style?: StyleProp<ViewStyle>;
  }
>(function NamuIconButton({icon, label, onPress, disabled = false, tone = 'primary', compact = false, testID, style}, ref) {
  const {colors} = useNamuTheme();
  const [focused, setFocused] = useState(false);
  const color =
    tone === 'action' ? colors.link
    : tone === 'error' ? colors.error
    : tone === 'secondary' ? colors.textSecondary
    : colors.textPrimary;
  const box = compact ? 36 : sizes.touchTarget;
  return (
    <Pressable
      ref={ref}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hitSlop={compact ? (sizes.touchTarget - box) / 2 : 4}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      style={({pressed}) => [
        {
          width: box,
          height: box,
          borderRadius: box / 2,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
          borderWidth: focused ? 2 : 0,
          borderColor: colors.focus,
        },
        style,
      ]}>
      <NamuIcon name={icon} color={color} size={compact ? 20 : undefined} />
    </Pressable>
  );
});
