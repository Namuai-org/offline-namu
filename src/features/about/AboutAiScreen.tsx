import React, {useState} from 'react';
import {Linking, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useHeaderHeight} from '@react-navigation/elements';
import {useTranslation} from 'react-i18next';
import {BUILD_FLAGS} from '../../app/buildFlags';
import {useServices} from '../../app/ServicesContext';
import {useTransferStore} from '../../app/stores';
import {RUNTIME_BUILD_ID} from '../../domain/inference/productionConfig';
import {PROMPT_VERSION} from '../../domain/chat/systemPrompt';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuText} from '../../design/components/NamuText';
import {ListRow, SectionHeader, StorageRow} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {safeLinkHost} from '../../design/markdown/parseMarkdown';
import {spacing} from '../../design/tokens';

/**
 * S10 — About the AI. Namu owns the product identity; Cohere Labs / Tiny Aya
 * attribution is always available here and Aya is never described as a model
 * trained by Namu (PRD-006). Every required notice is readable offline; the
 * upstream link is an optional user action.
 */
export function AboutAiScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const headerHeight = useHeaderHeight();
  const navigation = useNavigation();
  const services = useServices();
  const active = useTransferStore(s => s.snapshot.install.active);
  const [link, setLink] = useState<string | null>(null);
  const host = link ? safeLinkHost(link) : null;

  return (
    <Screen testID="about-screen" topInset={headerHeight}>

      <SectionHeader title={t('about.modelTitle')} />
      <NamuText>{t('about.modelBody')}</NamuText>
      <View>
        <StorageRow label={t('about.modelLabel')} value="Tiny Aya Global" />
        <StorageRow label={t('about.publisherLabel')} value="Cohere Labs" />
        <StorageRow label={t('about.formatLabel')} value={t('about.formatValue')} />
        <StorageRow label={t('about.modelVersionLabel')} value={active?.version ?? t('about.notInstalled')} />
        <StorageRow label={t('about.appVersionLabel')} value={`${services.info.appVersion} (${services.info.appBuild})`} />
        <StorageRow label={t('about.runtimeLabel')} value={`${RUNTIME_BUILD_ID} · ${PROMPT_VERSION}`} />
      </View>

      <SectionHeader title={t('about.limitsTitle')} />
      <NamuText>{t('about.limitsBody')}</NamuText>

      <SectionHeader title={t('about.licenseTitle')} />
      <NamuText tone="secondary">{t('about.licenseIntro')}</NamuText>
      <ListRow icon="description" title={t('about.viewLicense')} onPress={() => navigation.navigate('LegalText', {document: 'modelLicense'})} testID="about-license" />
      <ListRow icon="description" title="Creative Commons BY-NC 4.0" onPress={() => navigation.navigate('LegalText', {document: 'creativeCommons'})} />

      <SectionHeader title={t('about.noticesTitle')} />
      <NamuText tone="secondary">{t('about.noticesBody')}</NamuText>
      <ListRow icon="description" title={t('about.viewNotices')} onPress={() => navigation.navigate('LegalText', {document: 'openSource'})} testID="about-notices" />
      <ListRow icon="description" title="DM Sans · Material Symbols" onPress={() => navigation.navigate('LegalText', {document: 'fonts'})} />

      <NamuButton label={t('about.upstreamLink')} icon="open_in_new" variant="text" onPress={() => setLink(BUILD_FLAGS.upstreamModelUrl)} />
      <View style={{height: spacing.xl}} />

      <NamuDialog
        visible={link !== null}
        title={t('chat.linkTitle')}
        message={t('chat.linkBody', {host: host ?? ''})}
        onDismiss={() => setLink(null)}
        actions={[
          {
            label: t('chat.linkOpen'),
            variant: 'primary',
            onPress: () => {
              const target = link;
              setLink(null);
              if (target && safeLinkHost(target)) {
                void Linking.openURL(target).catch(() => undefined);
              }
            },
          },
          {label: t('common.cancel'), onPress: () => setLink(null)},
        ]}
      />
    </Screen>
  );
}
