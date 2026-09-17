import React, {useState} from 'react';
import {StyleSheet, TextInput, View, type TextInputProps} from 'react-native';
import {useNamuTheme} from '../theme';
import {fonts, radii, sizes, spacing, typeScale} from '../tokens';
import {NamuText} from './NamuText';

export interface NamuTextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  /** Visible label above the field; when false the label is accessibility-only. */
  showLabel?: boolean;
  error?: string | null;
  helper?: string | null;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

/** DS-005: focused, disabled and error states; the error is text, not only colour. */
export const NamuTextField = React.forwardRef<TextInput, NamuTextFieldProps>(function NamuTextField(
  {label, showLabel = true, error, helper, leading, trailing, editable = true, onFocus, onBlur, ...rest},
  ref,
) {
  const {colors} = useNamuTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error ? colors.error : focused ? colors.focus : colors.outline;
  return (
    <View style={{gap: spacing.xs}}>
      {showLabel ? (
        <NamuText variant="label" weight="medium" tone="secondary">
          {label}
        </NamuText>
      ) : null}
      <View
        style={[
          styles.box,
          {borderColor, borderWidth: focused || error ? 2 : 1, backgroundColor: colors.surface, opacity: editable ? 1 : 0.5},
        ]}>
        {leading}
        <TextInput
          ref={ref}
          {...rest}
          editable={editable}
          accessibilityLabel={label}
          accessibilityHint={error ?? helper ?? undefined}
          placeholderTextColor={colors.textSecondary}
          selectionColor={colors.action}
          cursorColor={colors.action}
          onFocus={e => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={e => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, {color: colors.textPrimary}]}
        />
        {trailing}
      </View>
      {error ? (
        <NamuText variant="label" tone="error" accessibilityLiveRegion="polite">
          {error}
        </NamuText>
      ) : helper ? (
        <NamuText variant="label" tone="secondary">
          {helper}
        </NamuText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    minHeight: sizes.touchTarget,
    borderRadius: radii.control,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: typeScale.body.fontSize,
    paddingVertical: spacing.md,
  },
});
