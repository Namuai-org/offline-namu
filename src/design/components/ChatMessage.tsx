import React from 'react';
import {Pressable, Text, View} from 'react-native';
import {useNamuTheme} from '../theme';
import {fonts, radii, spacing, typeScale} from '../tokens';
import {detectDirection} from '../markdown/direction';
import {MarkdownView} from '../markdown/MarkdownView';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {NamuIconButton} from './NamuIconButton';
import {NamuText} from './NamuText';

/** S04: user text sits in a subtle surface bubble, aligned to the end edge. */
export const UserMessage = React.memo(function UserMessage({
  text,
  authorLabel,
  copyLabel,
  onCopy,
}: {
  text: string;
  authorLabel: string;
  copyLabel: string;
  onCopy: () => void;
}) {
  const {colors} = useNamuTheme();
  const direction = detectDirection(text);
  return (
    <View style={{alignItems: 'flex-end', gap: spacing.xs}}>
      <View
        accessible
        accessibilityLabel={`${authorLabel}: ${text}`}
        style={{
          maxWidth: '88%',
          backgroundColor: colors.surfaceAlt,
          borderRadius: radii.surface,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        }}>
        <Text
          selectable
          style={{
            fontFamily: fonts.regular,
            fontSize: typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
            color: colors.textPrimary,
            writingDirection: direction,
            textAlign: direction === 'rtl' ? 'right' : 'left',
          }}>
          {text}
        </Text>
      </View>
      <NamuIconButton icon="content_copy" label={copyLabel} tone="secondary" onPress={onCopy} />
    </View>
  );
});

export interface AssistantAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Unfamiliar controls are paired with text (DS-003). */
  showLabel?: boolean;
  testID?: string;
}

/**
 * S04: assistant text is a readable full-width response. While generating it
 * is plain text; bounded Markdown is parsed once at completion.
 */
export const AssistantMessage = React.memo(function AssistantMessage({
  text,
  streaming,
  statusLabel,
  statusTone = 'secondary',
  note,
  actions,
  onLinkPress,
  testID,
}: {
  text: string;
  streaming: boolean;
  /** Visible text status: answering, stopped, interrupted, length limit… */
  statusLabel?: string;
  statusTone?: 'secondary' | 'error';
  note?: string;
  actions: AssistantAction[];
  onLinkPress: (href: string, hostname: string) => void;
  testID?: string;
}) {
  const {colors} = useNamuTheme();
  const direction = detectDirection(text);
  return (
    <View testID={testID} style={{gap: spacing.sm}}>
      {text.length > 0 ? (
        streaming ? (
          <Text
            // Tokens must not steal focus or be announced one by one (A11Y-001).
            accessibilityLiveRegion="none"
            importantForAccessibility="no-hide-descendants"
            style={{
              fontFamily: fonts.regular,
              fontSize: typeScale.body.fontSize,
              lineHeight: typeScale.body.lineHeight,
              color: colors.textPrimary,
              writingDirection: direction,
              textAlign: direction === 'rtl' ? 'right' : 'left',
            }}>
            {text}
          </Text>
        ) : (
          <MarkdownView source={text} onLinkPress={onLinkPress} />
        )
      ) : null}
      {statusLabel ? (
        <View style={{flexDirection: 'row', alignItems: 'center', gap: spacing.xs}}>
          <NamuIcon name={statusTone === 'error' ? 'error' : 'info'} size={18} color={statusTone === 'error' ? colors.error : colors.textSecondary} />
          <NamuText variant="label" tone={statusTone === 'error' ? 'error' : 'secondary'} style={{flex: 1}}>
            {statusLabel}
          </NamuText>
        </View>
      ) : null}
      {note ? (
        <NamuText variant="label" tone="secondary">
          {note}
        </NamuText>
      ) : null}
      {actions.length > 0 ? (
        <View style={{flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs}}>
          {actions.map(action =>
            action.showLabel ? (
              <LabeledAction key={action.label} {...action} />
            ) : (
              <NamuIconButton key={action.label} icon={action.icon} label={action.label} tone="secondary" onPress={action.onPress} testID={action.testID} />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
});

function LabeledAction({icon, label, onPress, testID}: AssistantAction) {
  const {colors} = useNamuTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        minHeight: 48,
        paddingHorizontal: spacing.md,
        opacity: pressed ? 0.6 : 1,
      })}>
      <NamuIcon name={icon} size={18} color={colors.link} />
      <NamuText variant="label" weight="medium" tone="action">
        {label}
      </NamuText>
    </Pressable>
  );
}
