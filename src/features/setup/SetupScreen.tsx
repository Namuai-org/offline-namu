import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, View} from 'react-native';
import {StackActions, useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {useTransferStore} from '../../app/stores';
import {evaluateEligibility, requiredAdditionalBytes, type Eligibility} from '../../domain/model/eligibility';
import type {DeviceProfile} from '../../domain/model/services';
import type {DescriptorSummary, TransferInfo} from '../../domain/model/transferTypes';
import {DownloadProgress} from '../../design/components/DownloadProgress';
import {GlassSurface} from '../../design/components/GlassSurface';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuText} from '../../design/components/NamuText';
import {StorageRow} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {StatusNotice} from '../../design/components/StatusNotice';
import {spacing} from '../../design/tokens';
import {formatPercent} from '../../locales/format';
import {useErrorCopy, useFormatters, useIsMounted} from '../shared/hooks';

/**
 * S02 (device and download) and S03 (setup progress) as one flow above the
 * tabs. Progress comes from native snapshots, so it survives app restarts
 * (S03) and the screen never declares anything installed itself (ARC-003).
 */
export function SetupScreen(): React.JSX.Element {
  const snapshot = useTransferStore(s => s.snapshot);
  const transfer = snapshot.transfer;
  const showProgress = transfer !== null && !transfer.isUpdate && transfer.phase !== 'absent';
  if (showProgress || snapshot.install.state === 'installed') {
    return <SetupProgress transfer={transfer} installed={snapshot.install.state === 'installed'} />;
  }
  return <DeviceCheck />;
}

// ----------------------------------------------------------------------- S02

function DeviceCheck(): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const services = useServices();
  const format = useFormatters();
  const errorCopy = useErrorCopy();
  const snapshot = useTransferStore(s => s.snapshot);
  const isMounted = useIsMounted();
  const meteredButton = useRef(null);

  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [descriptor, setDescriptor] = useState<DescriptorSummary | null>(null);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [confirmMetered, setConfirmMetered] = useState(false);
  const [starting, setStarting] = useState(false);

  const [checkFailed, setCheckFailed] = useState(false);
  const runCheck = useCallback(async () => {
    setCheckFailed(false);
    try {
      const [p, d] = await Promise.all([services.device.profile(), services.transfer.bundledDescriptor()]);
      await services.install.refresh().catch(() => undefined);
      if (!isMounted()) {
        return;
      }
      setProfile(p);
      setDescriptor(d);
      setEligibility(
        evaluateEligibility(p, services.info.osName, {
          allowSimulatorWithoutMetal: services.info.isInternalBuild && services.info.isSimulator,
        }),
      );
    } catch {
      if (isMounted()) {
        setCheckFailed(true);
      }
    }
  }, [isMounted, services]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const leave = () => (navigation.canGoBack() ? navigation.goBack() : navigation.dispatch(StackActions.popTo('Tabs')));

  const start = async (allowMetered: boolean) => {
    setConfirmMetered(false);
    setStarting(true);
    services.device.haptic('action');
    try {
      await services.transfer.start('bundled', allowMetered);
      await services.install.refresh();
    } catch {
      // The failure is reported through the snapshot's error code.
      await services.install.refresh().catch(() => undefined);
    } finally {
      if (isMounted()) {
        setStarting(false);
      }
    }
  };

  if (!profile || !descriptor || !eligibility) {
    return (
      <Screen edges={['top', 'bottom', 'left', 'right']} testID="setup-checking">
        <NamuText variant="title" align="center" accessibilityRole="header">{t('setup.title')}</NamuText>
        {checkFailed ? (
          <StatusNotice
            tone="error"
            testID="setup-check-failed"
            message={t('setup.checkFailed')}
            action={{label: t('common.retry'), onPress: () => void runCheck()}}
          />
        ) : (
          <NamuText tone="secondary">{t('setup.checking')}</NamuText>
        )}
        <NamuButton label={t('setup.later')} variant="text" onPress={leave} />
      </Screen>
    );
  }

  const bytes = descriptor.bytes ?? 0;
  const required = requiredAdditionalBytes(bytes, 0);
  const missing = Math.max(0, required - profile.freeDiskBytes);
  const ineligible = !eligibility.eligible;
  const descriptorBad = !descriptor.valid || bytes <= 0;
  const online = snapshot.network.connected;
  const metered = snapshot.network.metered;
  const canDownload = !ineligible && !descriptorBad && missing === 0 && online;

  const reasonText = {
    memory: t('setup.ineligibleMemory'),
    os: t('setup.ineligibleOs'),
    abi: t('setup.ineligibleAbi'),
    metal: t('setup.ineligibleMetal'),
  };

  return (
    <Screen
      edges={['top', 'bottom', 'left', 'right']}
      testID="setup-device"
      footer={
        <>
          {canDownload && !metered ? (
            <NamuButton label={t('setup.download')} icon="download" loading={starting} onPress={() => start(false)} testID="setup-download" />
          ) : null}
          {canDownload && metered ? (
            <>
              {/* DL-006: Wi-Fi only by default; starting now waits for an unmetered network. */}
              <NamuButton label={t('setup.download')} icon="download" loading={starting} onPress={() => start(false)} testID="setup-download" />
              <NamuButton
                ref={meteredButton}
                label={t('setup.useMobileData')}
                variant="secondary"
                onPress={() => setConfirmMetered(true)}
                testID="setup-metered"
              />
            </>
          ) : null}
          {ineligible ? <NamuButton label={t('common.help')} icon="help" variant="secondary" onPress={() => navigation.navigate('Help')} /> : null}
          <NamuButton label={ineligible ? t('common.back') : t('setup.later')} variant="text" onPress={leave} testID="setup-later" />
        </>
      }>
      <NamuText variant="title" align="center" accessibilityRole="header">{t('setup.title')}</NamuText>

      {ineligible ? (
        <StatusNotice
          tone="error"
          testID="setup-ineligible"
          title={t('setup.ineligibleTitle')}
          message={[...eligibility.reasons.map(r => reasonText[r]), t('setup.ineligibleKeep')].join('\n\n')}
          code="DEVICE_INELIGIBLE"
        />
      ) : null}
      {descriptorBad ? (
        <StatusNotice tone="error" title={errorCopy('SIGNATURE_INVALID').title} message={t('setup.descriptorInvalid')} code={descriptor.errorCode ?? 'SIGNATURE_INVALID'} />
      ) : null}

      {!descriptorBad ? (
        <GlassSurface contentStyle={{paddingHorizontal: spacing.lg, paddingVertical: spacing.sm}}>
          {/* Human-readable size derived from the signed exact byte count (S02). */}
          <StorageRow label={t('setup.packageSize')} value={format.bytes(bytes)} testID="setup-size" />
          <StorageRow label={t('setup.availableStorage')} value={format.bytes(profile.freeDiskBytes)} />
          <StorageRow label={t('setup.requiredStorage')} value={format.bytes(required)} tone={missing > 0 ? 'error' : 'primary'} />
        </GlassSurface>
      ) : null}

      {!ineligible && missing > 0 ? (
        <StatusNotice tone="warning" title={errorCopy('SPACE_LOW').title} message={t('setup.needSpace', {bytes: format.bytes(missing)})} code="SPACE_LOW" />
      ) : null}
      {!ineligible && !online ? <StatusNotice tone="info" testID="setup-offline" message={t('setup.noConnection')} /> : null}
      {!ineligible && online ? <StatusNotice tone="info" quiet message={t('setup.wifiNote')} /> : null}

      <NamuDialog
        visible={confirmMetered}
        title={t('setup.meteredTitle')}
        message={t('setup.meteredBody', {bytes: format.bytes(bytes)})}
        onDismiss={() => setConfirmMetered(false)}
        returnFocusTo={meteredButton}
        actions={[
          {label: t('setup.meteredConfirm'), variant: 'primary', onPress: () => start(true), testID: 'setup-metered-confirm'},
          {label: t('common.cancel'), onPress: () => setConfirmMetered(false)},
        ]}
      />
    </Screen>
  );
}

// ----------------------------------------------------------------------- S03

function SetupProgress({transfer, installed}: {transfer: TransferInfo | null; installed: boolean}): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const services = useServices();
  const format = useFormatters();
  const errorCopy = useErrorCopy();
  const network = useTransferStore(s => s.snapshot.network);
  const storage = useTransferStore(s => s.snapshot.storage);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmMetered, setConfirmMetered] = useState(false);
  const [busy, setBusy] = useState(false);
  const finishing = useRef(false);

  const phase = installed && (!transfer || transfer.phase === 'installed') ? 'installed' : transfer?.phase ?? 'absent';

  // DL-010: the foreground self-test starts as soon as a verified release is
  // staged and the app is in the foreground. It uses no user content.
  const finishIfStaged = useCallback(async () => {
    // Foreground only: a background/inactive app waits and shows
    // "Open Namu to finish setup" until it becomes active again.
    const appState = AppState.currentState;
    if (finishing.current || phase !== 'staged' || appState === 'background' || appState === 'inactive') {
      return;
    }
    finishing.current = true;
    try {
      await services.install.finishStagedInstall();
    } finally {
      finishing.current = false;
    }
  }, [phase, services]);

  useEffect(() => {
    void finishIfStaged().catch(() => undefined);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void services.install.refresh().then(finishIfStaged).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [finishIfStaged, services]);

  const announce = useCallback(
    (stage: string, percent: number | null) =>
      percent === null ? t('progress.announceStage', {stage}) : t('progress.announcePercent', {stage, percent}),
    [t],
  );

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    services.device.haptic('action');
    try {
      await fn();
    } catch {
      // surfaced by the next snapshot
    } finally {
      await services.install.refresh().catch(() => undefined);
      setBusy(false);
    }
  };

  let stageLabel = t(`progress.${phase === 'selfTesting' ? 'preparing' : phase}`);
  let fraction: number | null = null;
  let detail: string | undefined;
  if (transfer && (phase === 'downloading' || phase === 'paused' || phase === 'waiting')) {
    fraction = transfer.expectedBytes > 0 ? transfer.committedBytes / transfer.expectedBytes : 0;
    detail = t('progress.bytesOf', {done: format.bytes(transfer.committedBytes), total: format.bytes(transfer.expectedBytes)});
    if (phase === 'waiting') {
      stageLabel =
        transfer.errorCode === 'NETWORK_WAIT' || !network.connected ? t('progress.waitingNetwork')
        : network.metered && !transfer.meteredConsent ? t('progress.waitingWifi')
        : t('progress.waiting');
    }
  } else if (transfer && phase === 'verifying') {
    // Verification shows actual bytes hashed with its own percentage (S03).
    fraction = transfer.expectedBytes > 0 ? transfer.verifiedBytes / transfer.expectedBytes : 0;
    detail = t('progress.bytesOf', {done: format.bytes(transfer.verifiedBytes), total: format.bytes(transfer.expectedBytes)});
  } else if (phase === 'installed') {
    fraction = 1;
  }
  // Self-test and "open to finish" never show a fake percentage.
  const indeterminate = phase === 'selfTesting' || phase === 'staged';

  const failed = phase === 'failed' && transfer;
  const failure = failed && transfer.errorCode ? errorCopy(transfer.errorCode, {bytes: format.bytes(storage.requiredAdditionalBytes)}) : null;
  const waitingForWifi = phase === 'waiting' && network.connected && network.metered && transfer && !transfer.meteredConsent;
  const remaining = transfer ? Math.max(0, transfer.expectedBytes - transfer.committedBytes) : 0;

  return (
    <Screen
      edges={['top', 'bottom', 'left', 'right']}
      testID="setup-progress"
      footer={
        <>
          {phase === 'installed' ? (
            <NamuButton label={t('progress.startChat')} onPress={() => navigation.dispatch(StackActions.popTo('Tabs', {screen: 'Chat'}))} testID="setup-done" />
          ) : null}
          {transfer && (phase === 'downloading' || (phase === 'waiting' && !transfer.userPaused)) ? (
            <NamuButton label={t('progress.pause')} icon="pause" variant="secondary" disabled={busy} onPress={() => act(() => services.transfer.pause(transfer.transferId))} testID="setup-pause" />
          ) : null}
          {transfer && phase === 'paused' ? (
            <NamuButton label={t('progress.resume')} icon="play_arrow" disabled={busy} onPress={() => act(() => services.transfer.resume(transfer.transferId, transfer.meteredConsent))} testID="setup-resume" />
          ) : null}
          {waitingForWifi ? <NamuButton label={t('setup.useMobileData')} variant="secondary" onPress={() => setConfirmMetered(true)} /> : null}
          {failed ? (
            <NamuButton
              label={failure?.action ?? t('common.retry')}
              icon="refresh"
              disabled={busy}
              onPress={() =>
                act(async () => {
                  // Explicit user retry only; no hidden automatic retries (DL-006/007).
                  if (transfer.errorCode === 'TRANSFER_RETRY' || transfer.errorCode === 'SPACE_LOW' || transfer.errorCode === 'NETWORK_WAIT') {
                    // Valid partial data is retained: continue, do not start over.
                    await services.transfer.resume(transfer.transferId, transfer.meteredConsent);
                  } else {
                    // Damaged/unverifiable/incompatible staging was already removed natively.
                    await services.transfer.cancel(transfer.transferId);
                    await services.transfer.start('bundled', transfer.meteredConsent);
                  }
                })
              }
              testID="setup-retry"
            />
          ) : null}
          {transfer && phase !== 'installed' && phase !== 'selfTesting' ? (
            <NamuButton label={t('progress.cancelSetup')} variant="text" onPress={() => setConfirmCancel(true)} testID="setup-cancel" />
          ) : null}
          {phase !== 'installed' ? (
            <NamuButton label={t('common.close')} variant="text" onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.dispatch(StackActions.popTo('Tabs')))} />
          ) : null}
        </>
      }>
      <NamuText variant="title" align="center" accessibilityRole="header">{t('progress.title')}</NamuText>
      <DownloadProgress
        testID="setup-progress-surface"
        stageLabel={stageLabel}
        detail={detail}
        fraction={indeterminate ? null : fraction ?? 0}
        percentLabel={indeterminate || fraction === null ? undefined : t('progress.percent', {value: formatPercent(fraction)})}
        announce={announce}
      />
      {transfer?.restartedFromZero ? (
        <StatusNotice tone="warning" title={errorCopy('TRANSFER_RESTART').title} message={t('progress.restarted')} code="TRANSFER_RESTART" />
      ) : null}
      {phase === 'waiting' && transfer?.nextRetryAt ? <StatusNotice tone="info" quiet message={t('progress.retryIn')} /> : null}
      {phase === 'waiting' && transfer?.errorCode === 'SPACE_LOW' ? (
        <StatusNotice tone="warning" title={errorCopy('SPACE_LOW').title} message={errorCopy('SPACE_LOW', {bytes: format.bytes(storage.requiredAdditionalBytes)}).body} code="SPACE_LOW" />
      ) : null}
      {failure ? <StatusNotice tone="error" title={failure.title} message={failure.body} code={failure.code} testID="setup-failure" /> : null}

      <NamuDialog
        visible={confirmCancel}
        title={t('progress.cancelTitle')}
        message={t('progress.cancelBody')}
        onDismiss={() => setConfirmCancel(false)}
        actions={[
          {
            label: t('progress.cancelConfirm'),
            variant: 'destructive',
            testID: 'setup-cancel-confirm',
            onPress: () => {
              setConfirmCancel(false);
              if (transfer) {
                void act(() => services.transfer.cancel(transfer.transferId));
              }
            },
          },
          {label: t('progress.keepGoing'), onPress: () => setConfirmCancel(false)},
        ]}
      />
      <NamuDialog
        visible={confirmMetered}
        title={t('setup.meteredTitle')}
        message={t('setup.meteredBody', {bytes: format.bytes(remaining)})}
        onDismiss={() => setConfirmMetered(false)}
        actions={[
          {
            label: t('setup.meteredConfirm'),
            variant: 'primary',
            onPress: () => {
              setConfirmMetered(false);
              if (transfer) {
                // Per-transfer consent showing the remaining bytes (DL-006).
                void act(() => services.transfer.resume(transfer.transferId, true));
              }
            },
          },
          {label: t('common.cancel'), onPress: () => setConfirmMetered(false)},
        ]}
      />
      <View style={{height: spacing.sm}} />
    </Screen>
  );
}
