import React from 'react';
import {View} from 'react-native';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {useNamuTheme} from '../theme';
import {radii, spacing} from '../tokens';
import {GlassSurface} from './GlassSurface';
import {NamuButton} from './NamuButton';
import {NamuText} from './NamuText';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const ICONS: Record<NoticeTone, IconName> = {
  info: 'info',
  success: 'check_circle',
  warning: 'warning',
  error: 'error',
};

/**
 * DS-005: status is always conveyed by icon + text, never colour alone. Error
 * UI shows localized copy and a stable code only — no stack traces or paths.
 */
export function StatusNotice({
  tone,
  title,
  message,
  code,
  action,
  quiet = false,
  testID,
}: {
  tone: NoticeTone;
  title?: string;
  message: string;
  code?: string;
  action?: {label: string; onPress: () => void; loading?: boolean};
  /** Quiet notices (e.g. CTX-004) have no surface and secondary text. */
  quiet?: boolean;
  testID?: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  const accent = tone === 'error' ? colors.error : tone === 'info' && quiet ? colors.textSecondary : colors.link;
  const body = (
    <>
      <NamuIcon name={ICONS[tone]} color={accent} size={quiet ? 20 : 24} />
      <View style={{flex: 1, gap: spacing.xs}}>
        {title ? (
          <NamuText weight="semibold" tone={tone === 'error' ? 'error' : 'primary'}>
            {title}
          </NamuText>
        ) : null}
        <NamuText variant={quiet ? 'label' : 'body'} tone={quiet ? 'secondary' : 'primary'}>
          {message}
        </NamuText>
        {code ? (
          <NamuText variant="label" tone="secondary" selectable>
            {code}
          </NamuText>
        ) : null}
        {action ? (
          <NamuButton
            label={action.label}
            onPress={action.onPress}
            loading={action.loading}
            variant="secondary"
            style={{alignSelf: 'flex-start', marginTop: spacing.sm}}
          />
        ) : null}
      </View>
    </>
  );
  const a11y = {
    testID,
    accessibilityRole: (tone === 'error' ? 'alert' : 'summary') as 'alert' | 'summary',
    accessibilityLiveRegion: (tone === 'error' ? 'assertive' : 'polite') as 'assertive' | 'polite',
  };
  if (quiet) {
    return (
      <View {...a11y} style={{flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', paddingVertical: spacing.xs}}>
        {body}
      </View>
    );
  }
  return (
    <GlassSurface
      radius={radii.surface}
      contentStyle={tone === 'error' ? {borderColor: colors.error, borderWidth: 1} : undefined}>
      <View {...a11y} style={{flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', padding: spacing.lg}}>
        {body}
      </View>
    </GlassSurface>
  );
}