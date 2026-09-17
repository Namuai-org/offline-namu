import React from 'react';
import {View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {useAppStore, useTransferStore} from '../../app/stores';
import {APP_LANGUAGES, type ThemePreference} from '../../data/repositories/PreferencesRepository';
import {RESPONSE_LANGUAGES} from '../../data/types';
import {NamuText} from '../../design/components/NamuText';
import {ChoiceRow, ListRow, SectionHeader} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {spacing} from '../../design/tokens';
import {ReturnToAnswerBanner} from '../shared/ReturnToAnswerBanner';

const THEMES: {value: ThemePreference; key: string}[] = [
  {value: 'system', key: 'settings.themeSystem'},
  {value: 'light', key: 'settings.themeLight'},
  {value: 'dark', key: 'settings.themeDark'},
];

/**
 * S06 — Settings. Sections: Language, Appearance, Offline storage, Privacy
 * and data, Help, About. There are no performance tuning controls, no model
 * or runtime selectors and no sampling settings (PRD-002).
 */
export function SettingsScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const services = useServices();
  const preferences = useAppStore(s => s.preferences);
  const installState = useTransferStore(s => s.snapshot.install.state);
  if (!preferences) {
    return <Screen edges={['top', 'left', 'right']}>{null}</Screen>;
  }
  const storageStatus =
    installState === 'installed' ? t('storage.statusReady')
    : installState === 'needsRepair' ? t('storage.statusNeedsRepair')
    : t('storage.statusNeedsSetup');

  return (
    <Screen edges={['top', 'left', 'right']} testID="settings-screen">
      <NamuText variant="title" accessibilityRole="header">
        {t('settings.title')}
      </NamuText>
      <ReturnToAnswerBanner />

      <SectionHeader title={t('settings.language')} />
      <NamuText variant="label" weight="medium" tone="secondary">
        {t('settings.appLanguage')}
      </NamuText>
      <View accessibilityRole="radiogroup" style={{gap: spacing.sm}}>
        {APP_LANGUAGES.map(language => (
          <ChoiceRow
            key={language}
            testID={`settings-language-${language}`}
            title={t(`languageNames.${language}`)}
            selected={preferences.appLanguage === language}
            onPress={() => void services.setPreference('appLanguage', language).catch(() => undefined)}
          />
        ))}
      </View>
      {/* App language and response language are independent (CTX-006). */}
      <NamuText variant="label" weight="medium" tone="secondary" style={{marginTop: spacing.md}}>
        {t('settings.defaultResponseLanguage')}
      </NamuText>
      <View accessibilityRole="radiogroup" style={{gap: spacing.sm}}>
        {RESPONSE_LANGUAGES.map(language => (
          <ChoiceRow
            key={language}
            title={t(`responseLanguage.${language}`)}
            selected={preferences.responseLanguage === language}
            onPress={() => void services.setPreference('responseLanguage', language).catch(() => undefined)}
          />
        ))}
      </View>
      <NamuText variant="label" tone="secondary">
        {t('settings.defaultResponseNote')}
      </NamuText>

      <SectionHeader title={t('settings.appearance')} />
      <View accessibilityRole="radiogroup" style={{gap: spacing.sm}}>
        {THEMES.map(theme => (
          <ChoiceRow
            key={theme.value}
            testID={`settings-theme-${theme.value}`}
            title={t(theme.key)}
            selected={preferences.theme === theme.value}
            onPress={() => void services.setPreference('theme', theme.value).catch(() => undefined)}
          />
        ))}
      </View>

      <SectionHeader title={t('settings.storage')} />
      <ListRow icon="sd_storage" title={t('settings.storage')} subtitle={storageStatus} onPress={() => navigation.navigate('OfflineStorage')} testID="settings-storage" />
      <SectionHeader title={t('settings.privacy')} />
      <ListRow icon="shield" title={t('settings.privacy')} onPress={() => navigation.navigate('Privacy')} testID="settings-privacy" />
      <SectionHeader title={t('settings.help')} />
      <ListRow icon="help" title={t('settings.help')} onPress={() => navigation.navigate('Help')} testID="settings-help" />
      <SectionHeader title={t('settings.about')} />
      <ListRow icon="info" title={t('settings.aboutAi')} subtitle={`Namu ${services.info.appVersion}`} onPress={() => navigation.navigate('AboutAi')} testID="settings-about" />
      <View style={{height: spacing.xl}} />
    </Screen>
  );
}
