import React, {useState} from 'react';
import {Pressable, View} from 'react-native';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {useNamuTheme} from '../theme';
import {sizes, spacing} from '../tokens';
import {NamuText} from './NamuText';

/** S07 label/value row. Text-bearing, so no fixed height (DS-002). */
export function StorageRow({
  label,
  value,
  tone = 'primary',
  testID,
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'error' | 'action';
  testID?: string;
}): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        gap: spacing.sm,
        minHeight: sizes.touchTarget,
        alignItems: 'center',
        paddingVertical: spacing.sm,
      }}>
      <NamuText tone="secondary" style={{flexShrink: 1}}>
        {label}
      </NamuText>
      <NamuText weight="medium" tone={tone} style={{flexShrink: 1}}>
        {value}
      </NamuText>
    </View>
  );
}

/** Navigation / action row used in Settings and Help. */
export function ListRow({
  icon,
  title,
  subtitle,
  onPress,
  destructive = false,
  trailing,
  testID,
}: {
  icon?: IconName;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  destructive?: boolean;
  trailing?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  const [focused, setFocused] = useState(false);
  const color = destructive ? colors.error : colors.textPrimary;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      style={({pressed}) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: sizes.touchTarget + spacing.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xs,
        opacity: pressed ? 0.6 : 1,
        borderWidth: focused ? 2 : 0,
        borderColor: colors.focus,
        borderRadius: 8,
      })}>
      {icon ? <NamuIcon name={icon} color={destructive ? colors.error : colors.textSecondary} /> : null}
      <View style={{flex: 1, gap: 2}}>
        <NamuText style={{color}} weight="medium">
          {title}
        </NamuText>
        {subtitle ? (
          <NamuText variant="label" tone="secondary">
            {subtitle}
          </NamuText>
        ) : null}
      </View>
      {trailing ?? (onPress ? <NamuIcon name="chevron_right" color={colors.textSecondary} /> : null)}
    </Pressable>
  );
}

/** Single-choice row (language, appearance). Selection is shown by icon + state. */
export function ChoiceRow({
  title,
  subtitle,
  selected,
  onPress,
  testID,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{selected, checked: selected}}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      style={({pressed}) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: sizes.touchTarget + spacing.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: 12,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.action : colors.outline,
        backgroundColor: colors.surface,
        opacity: pressed ? 0.7 : 1,
      })}>
      <View style={{flex: 1, gap: 2}}>
        <NamuText weight="medium">{title}</NamuText>
        {subtitle ? (
          <NamuText variant="label" tone="secondary">
            {subtitle}
          </NamuText>
        ) : null}
      </View>
      {selected ? <NamuIcon name="check" color={colors.action} /> : <View style={{width: sizes.icon}} />}
    </Pressable>
  );
}

export function SectionHeader({title}: {title: string}): React.JSX.Element {
  return (
    <NamuText
      variant="label"
      weight="semibold"
      tone="secondary"
      accessibilityRole="header"
      style={{marginTop: spacing.xl, marginBottom: spacing.xs, textTransform: 'uppercase', letterSpacing: 0.6}}>
      {title}
    </NamuText>
  );
}
