import React from 'react';
import {Pressable, Text, View} from 'react-native';
import {useNamuTheme} from '../theme';
import {fonts, spacing, typeScale} from '../tokens';
import {detectDirection} from '../markdown/direction';
import {MarkdownView} from '../markdown/MarkdownView';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {NamuIconButton} from './NamuIconButton';
import {NamuText} from './NamuText';
import {ThinkingDot} from './ThinkingDot';

/** Trailing marker of text that is still being written. */
const STREAM_CARET = ` ${String.fromCharCode(0x25cf)}`;

/**
 * S04: user text sits in a subtle surface bubble, aligned to the end edge.
 * Long-press opens the message options (copy); assistive technology gets the
 * same action without a gesture.
 */
export const UserMessage = React.memo(function UserMessage({
  text,
  authorLabel,
  copyLabel,
  pending = false,
  onCopy,
  onLongPress,
}: {
  text: string;
  authorLabel: string;
  copyLabel: string;
  /** Shown immediately on Send, before the durable commit (CHAT-001). */
  pending?: boolean;
  onCopy: () => void;
  onLongPress?: () => void;
}) {
  const {colors} = useNamuTheme();
  const direction = detectDirection(text);
  return (
    <View style={{alignItems: 'flex-end'}}>
      <Pressable
        accessible
        accessibilityLabel={`${authorLabel}: ${text}`}
        accessibilityActions={[{name: 'copy', label: copyLabel}]}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'copy') {
            onCopy();
          }
        }}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={({pressed}) => ({
          maxWidth: '82%',
          backgroundColor: colors.surfaceAlt,
          borderRadius: 22,
          paddingHorizontal: spacing.lg,
          paddingVertical: 10,
          opacity: pending ? 0.7 : pressed && onLongPress ? 0.8 : 1,
        })}>
        <Text
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
      </Pressable>
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
  thinkingLabel,
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
  /** While streaming with no text yet: a pulsing dot with this quiet label. */
  thinkingLabel?: string;
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
            <Text style={{color: colors.textSecondary, fontSize: 12}}>{STREAM_CARET}</Text>
          </Text>
        ) : (
          <MarkdownView source={text} onLinkPress={onLinkPress} />
        )
      ) : streaming && thinkingLabel ? (
        <View style={{flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 28}}>
          <ThinkingDot />
          <NamuText variant="label" tone="secondary">
            {thinkingLabel}
          </NamuText>
        </View>
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
        <View style={{flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginStart: -8}}>
          {actions.map(action =>
            action.showLabel ? (
              <LabeledAction key={action.label} {...action} />
            ) : (
              <NamuIconButton key={action.label} compact icon={action.icon} label={action.label} tone="secondary" onPress={action.onPress} testID={action.testID} />
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
        minHeight: 36,
        paddingHorizontal: spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}>
      <NamuIcon name={icon} size={18} color={colors.textSecondary} />
      <NamuText variant="label" weight="medium" tone="secondary">
        {label}
      </NamuText>
    </Pressable>
  );
}
