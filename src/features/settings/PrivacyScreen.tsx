import React, {useState} from 'react';
import {View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useHeaderHeight} from '@react-navigation/elements';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {useAppStore, useChatViewStore} from '../../app/stores';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuText} from '../../design/components/NamuText';
import {SectionHeader} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {StatusNotice} from '../../design/components/StatusNotice';
import {spacing} from '../../design/tokens';
import {useExport} from '../shared/useExport';

/**
 * S08 — Privacy and data. There is no telemetry toggle because v1 performs no
 * automatic telemetry upload. Diagnostic export lives in Help.
 */
export function PrivacyScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const headerHeight = useHeaderHeight();
  const navigation = useNavigation();
  const services = useServices();
  const exporter = useExport();
  const readOnly = useAppStore(s => s.databaseMode === 'recovery');
  const onboarded = useAppStore(s => s.preferences?.onboardingComplete === true);
  const [confirm, setConfirm] = useState<'conversations' | 'everything' | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{tone: 'success' | 'error'; text: string} | null>(null);

  const deleteConversations = async () => {
    setWorking(true);
    try {
      // SEC-006: cancel generation, clear conversations/attempts/drafts/search
      // index; preserve model and settings.
      const quiet = await services.chat.quiesce();
      if (!quiet) {
        setMessage({tone: 'error', text: t('privacy.deferred')});
        return;
      }
      await services.conversations?.deleteAll();
      await services.database?.checkpointTruncate().catch(() => undefined); // SEC-007
      useChatViewStore.getState().open(null);
      useAppStore.getState().touchConversations();
      services.device.haptic('success');
      setMessage({tone: 'success', text: t('privacy.done')});
    } catch {
      setMessage({tone: 'error', text: t('errors.STORAGE_WRITE_FAILED.title')});
    } finally {
      setWorking(false);
      setConfirm(null);
    }
  };

  const deleteEverything = async () => {
    setWorking(true);
    try {
      const deleted = await services.deleteAllData();
      if (!deleted) {
        // Shutdown unconfirmed: defer deletion and ask the user to reopen.
        setMessage({tone: 'error', text: t('privacy.deferred')});
        return;
      }
      // Returns to S01 with fresh state: the app root restarts its services.
      useChatViewStore.getState().open(null);
      restartApp();
    } catch {
      setMessage({tone: 'error', text: t('privacy.deferred')});
    } finally {
      setWorking(false);
      setConfirm(null);
    }
  };

  const paragraphs: [string, string][] = [
    [t('privacy.noUploadTitle'), t('privacy.noUploadBody')],
    [t('privacy.networkTitle'), t('privacy.networkBody')],
    [t('privacy.backupTitle'), t('privacy.backupBody')],
    [t('privacy.protectionTitle'), t('privacy.protectionBody')],
  ];

  return (
    <Screen testID="privacy-screen" topInset={headerHeight}>
      {paragraphs.map(([title, body]) => (
        <View key={title} style={{gap: spacing.xs, marginTop: spacing.sm}}>
          <NamuText weight="semibold" accessibilityRole="header">
            {title}
          </NamuText>
          <NamuText tone="secondary">{body}</NamuText>
        </View>
      ))}

      {message ? <StatusNotice tone={message.tone} message={message.text} testID="privacy-message" /> : null}

      {onboarded ? (
        <>
          <SectionHeader title={t('settings.privacy')} />
          <NamuText variant="label" tone="secondary">
            {t('export.warningBody')}
          </NamuText>
          <NamuButton label={t('privacy.exportAll')} icon="ios_share" variant="secondary" onPress={() => exporter.request({kind: 'all'})} testID="privacy-export-all" />
          {!readOnly ? (
            <NamuButton label={t('privacy.deleteConversations')} icon="delete" variant="secondary" onPress={() => setConfirm('conversations')} testID="privacy-delete-conversations" />
          ) : null}
          <NamuButton label={t('privacy.deleteEverything')} icon="delete_forever" variant="destructive" onPress={() => setConfirm('everything')} testID="privacy-delete-everything" />
          <NamuText variant="label" tone="secondary">
            {t('privacy.deletionNote')}
          </NamuText>
        </>
      ) : (
        <NamuButton label={t('common.back')} variant="text" onPress={() => navigation.goBack()} />
      )}

      {/* Each destructive scope has its own confirmation naming the scope (SEC-006). */}
      <NamuDialog
        visible={confirm === 'conversations'}
        title={t('privacy.deleteConversationsTitle')}
        message={t('privacy.deleteConversationsBody')}
        dismissable={!working}
        onDismiss={() => setConfirm(null)}
        actions={[
          {label: t('privacy.deleteConversationsConfirm'), variant: 'destructive', loading: working, onPress: () => void deleteConversations(), testID: 'confirm-delete-conversations'},
          {label: t('common.cancel'), disabled: working, onPress: () => setConfirm(null)},
        ]}
      />
      <NamuDialog
        visible={confirm === 'everything'}
        title={t('privacy.deleteEverythingTitle')}
        message={t('privacy.deleteEverythingBody')}
        dismissable={!working}
        onDismiss={() => setConfirm(null)}
        actions={[
          {label: t('privacy.deleteEverythingConfirm'), variant: 'destructive', loading: working, onPress: () => void deleteEverything(), testID: 'confirm-delete-everything'},
          {label: t('common.cancel'), disabled: working, onPress: () => setConfirm(null)},
        ]}
      />
      {exporter.dialogs}
    </Screen>
  );
}

/** Set by the app root so "Delete all Namu data" can rebuild services and return to S01. */
let restartHandler: () => void = () => undefined;
export function setRestartHandler(handler: () => void): void {
  restartHandler = handler;
}
function restartApp(): void {
  restartHandler();
}
