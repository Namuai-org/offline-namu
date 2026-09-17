import React, {useCallback, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import type {ExportLabels} from '../../domain/model/services';
import {NamuDialog} from '../../design/components/NamuDialog';

type Target = {kind: 'conversation'; id: string} | {kind: 'all'};

/**
 * SEC-004/005 export flow shared by S05, S08 and recovery: explicit warning
 * that files leave app protection → native streaming export → share sheet
 * only after completion → temporary file removed after sharing.
 */
export function useExport(): {request: (target: Target) => void; dialogs: React.JSX.Element} {
  const {t} = useTranslation();
  const services = useServices();
  const [pending, setPending] = useState<Target | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  const labels = useCallback(
    (): ExportLabels => ({
      created: t('export.labels.created'),
      updated: t('export.labels.updated'),
      responseLanguage: t('export.labels.responseLanguage'),
      languageNames: {
        auto: t('responseLanguage.auto'),
        ha: t('responseLanguage.ha'),
        fr: t('responseLanguage.fr'),
        en: t('responseLanguage.en'),
      },
      you: t('export.labels.you'),
      namu: t('export.labels.namu'),
      interrupted: t('export.labels.interrupted'),
      lengthLimited: t('export.labels.lengthLimited'),
      untitled: t('export.labels.untitled'),
    }),
    [t],
  );

  const run = async () => {
    const target = pending;
    if (!target) {
      return;
    }
    setWorking(true);
    let exportId: string | null = null;
    let handedOver = false;
    try {
      exportId =
        target.kind === 'all'
          ? await services.exporter.exportAll(labels())
          : await services.exporter.exportConversation(target.id, labels());
      setPending(null);
      handedOver = await services.exporter.share(exportId);
    } catch {
      // Interrupted exports leave the source data unchanged (SEC-005, T23).
      setPending(null);
      setFailed(true);
    } finally {
      if (exportId) {
        await services.exporter.cleanupAfterShare(exportId, handedOver).catch(() => undefined);
      }
      setWorking(false);
    }
  };

  const dialogs = (
    <>
      <NamuDialog
        visible={pending !== null}
        testID="export-warning"
        title={t('export.warningTitle')}
        message={working ? t('export.working') : t('export.warningBody')}
        dismissable={!working}
        onDismiss={() => setPending(null)}
        actions={[
          {label: t('export.continue'), variant: 'primary', loading: working, onPress: () => void run(), testID: 'export-confirm'},
          {label: t('common.cancel'), disabled: working, onPress: () => setPending(null)},
        ]}
      />
      <NamuDialog
        visible={failed}
        title={t('conversations.export')}
        message={t('export.failed')}
        onDismiss={() => setFailed(false)}
        actions={[{label: t('common.ok'), onPress: () => setFailed(false)}]}
      />
    </>
  );

  return {request: setPending, dialogs};
}
