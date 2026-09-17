import React, {useEffect, useState} from 'react';
import {View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {useChatSessionStore, useTransferStore} from '../../app/stores';
import type {ProductErrorCode} from '../../domain/inference/failures';
import {DownloadProgress} from '../../design/components/DownloadProgress';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuText} from '../../design/components/NamuText';
import {StorageRow} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {StatusNotice} from '../../design/components/StatusNotice';
import {spacing} from '../../design/tokens';
import {formatPercent} from '../../locales/format';
import {useErrorCopy, useFormatters, useIsMounted} from '../shared/hooks';

type Message = {tone: 'info' | 'success' | 'error'; text: string; code?: string};

/**
 * S07 — Offline storage. Update checks happen only on the user's tap
 * (SIG-005); a multi-gigabyte transfer never starts on its own; a failed
 * update never turns an installed model into "absent" (DL-015).
 */
export function OfflineStorageScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const services = useServices();
  const format = useFormatters();
  const errorCopy = useErrorCopy();
  const isMounted = useIsMounted();
  const snapshot = useTransferStore(s => s.snapshot);
  const generating = useChatSessionStore(s => s.session.active !== null);
  const {install, transfer, update, network} = snapshot;

  const [chatBytes, setChatBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirm, setConfirm] = useState<'remove' | 'restore' | 'metered' | null>(null);

  useEffect(() => {
    void services.device.chatDataSizeBytes().then(bytes => isMounted() && setChatBytes(bytes)).catch(() => undefined);
    void services.install.refresh().catch(() => undefined);
  }, [isMounted, services]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    services.device.haptic('action');
    try {
      await fn();
    } catch (error) {
      const code = (error as {code?: string} | null)?.code;
      setMessage({tone: 'error', text: code === 'ENGINE_BUSY' ? t('storage.busy') : errorCopy('TRANSFER_RETRY').body, code});
    } finally {
      await services.install.refresh().catch(() => undefined);
      if (isMounted()) {
        setBusy(null);
      }
    }
  };

  const checkForUpdates = () =>
    run('check', async () => {
      const result = await services.transfer.checkForUpdate();
      if (result.status === 'available') {
        setMessage(null); // the snapshot's `update` renders the offer
      } else if (result.status === 'none') {
        setMessage({tone: 'success', text: t('storage.upToDate')});
      } else {
        const code: ProductErrorCode | null = result.errorCode;
        setMessage({tone: 'error', text: code ? errorCopy(code).body : t('storage.checkFailed'), code: code ?? undefined});
      }
    });

  const downloadUpdate = (allowMetered: boolean) =>
    run('download', async () => {
      await services.transfer.start('update', allowMetered);
    });

  const installUpdate = () =>
    run('install', async () => {
      // T11: activation happens only on this explicit action while idle.
      const result = await services.install.finishStagedInstall();
      if (!result.ok) {
        setMessage({
          tone: 'error',
          text: result.reason === 'shutdown-unconfirmed' ? t('storage.busy') : t('storage.installFailed'),
        });
      }
    });

  const statusText =
    install.state === 'installed' ? t('storage.statusReady')
    : install.state === 'needsRepair' ? t('storage.statusNeedsRepair')
    : t('storage.statusNeedsSetup');

  const updateTransfer = transfer && transfer.isUpdate ? transfer : null;
  const updateActive = updateTransfer && ['waiting', 'downloading', 'paused', 'verifying'].includes(updateTransfer.phase);
  const updateFraction =
    updateTransfer && updateTransfer.expectedBytes > 0
      ? (updateTransfer.phase === 'verifying' ? updateTransfer.verifiedBytes : updateTransfer.committedBytes) / updateTransfer.expectedBytes
      : 0;

  return (
    <Screen testID="storage-screen">
      <NamuText variant="title" accessibilityRole="header">
        {t('storage.title')}
      </NamuText>
      <View>
        <StorageRow label={t('storage.status')} value={statusText} tone={install.state === 'installed' ? 'action' : 'error'} testID="storage-status" />
        <StorageRow label={t('storage.packageSize')} value={install.active ? format.bytes(install.active.bytes) : '—'} />
        <StorageRow label={t('storage.packageVersion')} value={install.active?.version ?? '—'} />
        <StorageRow label={t('storage.chatsSize')} value={chatBytes === null ? '…' : format.bytes(chatBytes)} />
      </View>
      <StatusNotice tone="info" quiet message={t('storage.chatsKept')} />

      {message ? <StatusNotice tone={message.tone} message={message.text} code={message.code} testID="storage-message" /> : null}

      {install.state === 'absent' && !transfer ? (
        <NamuButton label={t('storage.setUp')} icon="download" onPress={() => navigation.navigate('Setup')} testID="storage-setup" />
      ) : null}
      {transfer && !transfer.isUpdate && transfer.phase !== 'installed' ? (
        <NamuButton label={t('progress.title')} variant="secondary" onPress={() => navigation.navigate('Setup')} />
      ) : null}

      {install.state === 'installed' ? (
        <>
          <NamuButton
            label={busy === 'check' ? t('storage.checking') : t('storage.checkForUpdates')}
            icon="system_update"
            variant="secondary"
            loading={busy === 'check'}
            disabled={busy !== null || !network.connected}
            onPress={checkForUpdates}
            testID="storage-check"
          />
          <NamuText variant="label" tone="secondary">
            {t('storage.updateNote')}
          </NamuText>
        </>
      ) : null}

      {update && !updateTransfer ? (
        <>
          <StatusNotice tone="info" message={t('storage.updateAvailable', {bytes: format.bytes(update.bytes)})} testID="storage-update" />
          <NamuButton
            label={t('storage.downloadUpdate')}
            icon="download"
            disabled={busy !== null}
            onPress={() => (network.metered ? setConfirm('metered') : void downloadUpdate(false))}
            testID="storage-download-update"
          />
        </>
      ) : null}

      {updateTransfer && updateActive ? (
        <>
          <DownloadProgress
            stageLabel={t(`progress.${updateTransfer.phase}`)}
            fraction={updateFraction}
            percentLabel={t('progress.percent', {value: formatPercent(updateFraction)})}
            detail={t('progress.bytesOf', {
              done: format.bytes(updateTransfer.phase === 'verifying' ? updateTransfer.verifiedBytes : updateTransfer.committedBytes),
              total: format.bytes(updateTransfer.expectedBytes),
            })}
            announce={(stage, percent) =>
              percent === null ? t('progress.announceStage', {stage}) : t('progress.announcePercent', {stage, percent})
            }
          />
          <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}}>
            {updateTransfer.phase === 'paused' ? (
              <NamuButton label={t('progress.resume')} icon="play_arrow" variant="secondary" onPress={() => run('resume', () => services.transfer.resume(updateTransfer.transferId, updateTransfer.meteredConsent))} />
            ) : (
              <NamuButton label={t('progress.pause')} icon="pause" variant="secondary" onPress={() => run('pause', () => services.transfer.pause(updateTransfer.transferId))} />
            )}
            <NamuButton label={t('common.cancel')} variant="text" onPress={() => run('cancel', () => services.transfer.cancel(updateTransfer.transferId))} />
          </View>
        </>
      ) : null}
      {updateTransfer?.phase === 'staged' ? (
        <>
          <NamuButton label={t('storage.installUpdate')} icon="check_circle" loading={busy === 'install'} disabled={busy !== null || generating} onPress={installUpdate} testID="storage-install-update" />
          <NamuText variant="label" tone="secondary">
            {t('storage.installUpdateNote')}
          </NamuText>
        </>
      ) : null}
      {updateTransfer?.phase === 'selfTesting' ? <DownloadProgress stageLabel={t('progress.preparing')} fraction={null} announce={stage => t('progress.announceStage', {stage})} /> : null}
      {updateTransfer?.phase === 'failed' && updateTransfer.errorCode ? (
        <StatusNotice
          tone="error"
          title={errorCopy(updateTransfer.errorCode).title}
          message={errorCopy(updateTransfer.errorCode, {bytes: format.bytes(snapshot.storage.requiredAdditionalBytes)}).body}
          code={updateTransfer.errorCode}
          action={{label: t('common.close'), onPress: () => void run('dismiss', () => services.transfer.cancel(updateTransfer.transferId))}}
        />
      ) : null}

      {install.state !== 'absent' ? (
        <>
          <NamuButton label={t('storage.repair')} icon="build" variant="secondary" loading={busy === 'repair'} disabled={busy !== null} onPress={() => run('repair', () => services.install.repair())} testID="storage-repair" />
          <NamuText variant="label" tone="secondary">
            {t('storage.repairNote')}
          </NamuText>
        </>
      ) : null}
      {install.canRestorePrevious ? (
        <NamuButton label={t('storage.restorePrevious')} icon="history" variant="secondary" disabled={busy !== null} onPress={() => setConfirm('restore')} testID="storage-restore" />
      ) : null}
      {install.state !== 'absent' ? (
        <NamuButton label={t('storage.remove')} icon="delete" variant="text" disabled={busy !== null} onPress={() => setConfirm('remove')} testID="storage-remove" />
      ) : null}

      <NamuDialog
        visible={confirm === 'remove'}
        title={t('storage.removeTitle')}
        message={t('storage.removeBody')}
        onDismiss={() => setConfirm(null)}
        actions={[
          {
            label: t('storage.removeConfirm'),
            variant: 'destructive',
            testID: 'storage-remove-confirm',
            onPress: () => {
              setConfirm(null);
              // Cancel transfers and unload before file deletion (S07).
              void run('remove', async () => {
                if (!(await services.install.removeModel())) {
                  setMessage({tone: 'error', text: t('storage.busy')});
                }
              });
            },
          },
          {label: t('common.cancel'), onPress: () => setConfirm(null)},
        ]}
      />
      <NamuDialog
        visible={confirm === 'restore'}
        title={t('storage.restoreTitle')}
        message={t('storage.restoreBody')}
        onDismiss={() => setConfirm(null)}
        actions={[
          {
            label: t('storage.restorePrevious'),
            variant: 'primary',
            onPress: () => {
              setConfirm(null);
              void run('restore', async () => {
                if (!(await services.install.restorePrevious())) {
                  setMessage({tone: 'error', text: t('storage.busy')});
                }
              });
            },
          },
          {label: t('common.cancel'), onPress: () => setConfirm(null)},
        ]}
      />
      <NamuDialog
        visible={confirm === 'metered'}
        title={t('setup.meteredTitle')}
        message={t('setup.meteredBody', {bytes: format.bytes(update?.bytes ?? 0)})}
        onDismiss={() => setConfirm(null)}
        actions={[
          {
            label: t('setup.meteredConfirm'),
            variant: 'primary',
            onPress: () => {
              setConfirm(null);
              void downloadUpdate(true); // a new update needs new consent (DL-006)
            },
          },
          {
            label: t('setup.download'),
            onPress: () => {
              setConfirm(null);
              void downloadUpdate(false);
            },
          },
          {label: t('common.cancel'), onPress: () => setConfirm(null)},
        ]}
      />
    </Screen>
  );
}
