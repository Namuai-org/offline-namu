import React, {useState} from 'react';
import {Linking, Pressable, View} from 'react-native';
import {useHeaderHeight} from '@react-navigation/elements';
import {useTranslation} from 'react-i18next';
import {BUILD_FLAGS} from '../../app/buildFlags';
import {useServices} from '../../app/ServicesContext';
import {useChatSessionStore, useTransferStore} from '../../app/stores';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuText} from '../../design/components/NamuText';
import {SectionHeader, StorageRow} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {NamuIcon} from '../../design/icons/NamuIcon';
import {useNamuTheme} from '../../design/theme';
import {sizes, spacing} from '../../design/tokens';

const TOPICS = ['download', 'storage', 'slow', 'heat', 'missing', 'export', 'uninstall'] as const;

/**
 * S09 — Help / recovery. All help content is bundled and works offline.
 * Diagnostic details are previewed before the user copies them; they contain
 * no chat text, IDs, headers or paths (OBS-001) and are never sent
 * automatically. The support address appears only once configured.
 */
export function HelpScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const headerHeight = useHeaderHeight();
  const {colors} = useNamuTheme();
  const services = useServices();
  const lastError = useChatSessionStore(s => s.session.lastError?.code ?? null);
  const transferError = useTransferStore(s => s.snapshot.transfer?.errorCode ?? null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);

  const errorCode = lastError ?? transferError;

  const showDiagnostics = async () => {
    const events = (await services.diagnostics?.exportText().catch(() => '')) ?? '';
    const header = [
      `Namu ${services.info.appVersion} (${services.info.appBuild})`,
      `${services.info.osName} ${services.info.osVersion} · ${services.info.deviceModel}`,
      errorCode ? `last-error ${errorCode}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    setDiagnostics(events.length > 0 ? `${header}\n\n${events}` : `${header}\n\n${t('help.diagnosticsEmpty')}`);
  };

  return (
    <Screen testID="help-screen" topInset={headerHeight}>
      <SectionHeader title={t('help.topicsTitle')} />
      {TOPICS.map(topic => {
        const open = expanded === topic;
        return (
          <View key={topic} style={{borderBottomWidth: 1, borderBottomColor: colors.surfaceAlt}}>
            <Pressable
              testID={`help-topic-${topic}`}
              onPress={() => setExpanded(open ? null : topic)}
              accessibilityRole="button"
              accessibilityState={{expanded: open}}
              style={{flexDirection: 'row', alignItems: 'center', minHeight: sizes.touchTarget, paddingVertical: spacing.md, gap: spacing.sm}}>
              <NamuText weight="medium" style={{flex: 1}}>
                {t(`help.${topic}Title`)}
              </NamuText>
              <NamuIcon name={open ? 'expand_more' : 'chevron_right'} color={colors.textSecondary} />
            </Pressable>
            {open ? (
              <NamuText tone="secondary" style={{paddingBottom: spacing.lg}}>
                {t(`help.${topic}Body`)}
              </NamuText>
            ) : null}
          </View>
        );
      })}

      <SectionHeader title={t('help.diagnosticsTitle')} />
      <NamuText variant="label" tone="secondary">
        {t('help.diagnosticsBody')}
      </NamuText>
      {errorCode ? <StorageRow label={t('help.lastError')} value={errorCode} /> : null}
      <NamuButton label={t('help.diagnosticsView')} icon="description" variant="secondary" onPress={() => void showDiagnostics()} testID="help-diagnostics" />

      {BUILD_FLAGS.supportEmail ? (
        <>
          <NamuButton
            label={t('help.contact')}
            icon="mail"
            variant="secondary"
            // User initiated; nothing is attached or queued (S09, SEC-005).
            onPress={() => void Linking.openURL(`mailto:${BUILD_FLAGS.supportEmail}`).catch(() => undefined)}
          />
          <NamuText variant="label" tone="secondary">
            {t('help.contactNote')}
          </NamuText>
        </>
      ) : null}

      <NamuDialog
        visible={diagnostics !== null}
        title={t('help.diagnosticsTitle')}
        onDismiss={() => setDiagnostics(null)}
        actions={[
          {
            label: t('help.diagnosticsCopy'),
            variant: 'primary',
            onPress: () => {
              if (diagnostics) {
                services.device.copyToClipboard(diagnostics);
                services.announce(t('common.copied'));
              }
              setDiagnostics(null);
            },
          },
          {label: t('common.close'), onPress: () => setDiagnostics(null)},
        ]}>
        <NamuText variant="label" selectable>
          {diagnostics ?? ''}
        </NamuText>
      </NamuDialog>
    </Screen>
  );
}
