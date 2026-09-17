import React, {useState} from 'react';
import {View} from 'react-native';
import {useHeaderHeight} from '@react-navigation/elements';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {useAppStore, useTransferStore} from '../../app/stores';
import {APP_LANGUAGES, type ThemePreference} from '../../data/repositories/PreferencesRepository';
import {RESPONSE_LANGUAGES} from '../../data/types';
import {ActionSheet, type ActionSheetItem} from '../../design/components/ActionSheet';
import {SettingsGroup, SettingsRow} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {spacing} from '../../design/tokens';
import {ReturnToAnswerBanner} from '../shared/ReturnToAnswerBanner';

const THEMES: {value: ThemePreference; key: string}[] = [
  {value: 'system', key: 'settings.themeSystem'},
  {value: 'light', key: 'settings.themeLight'},
  {value: 'dark', key: 'settings.themeDark'},
];

type Picker = 'appLanguage' | 'answerLanguage' | 'theme';

/**
 * S06 — Settings, as grouped cards: General (app language, answer language,
 * appearance — each shows its current value and opens a choice list), Storage
 * and data, Help and about. Only things a person can act on or needs to
 * know: no performance tuning, no model or runtime selectors, no sampling
 * settings (PRD-002), and no account because Namu has none.
 */
export function SettingsScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const services = useServices();
  const preferences = useAppStore(s => s.preferences);
  const installState = useTransferStore(s => s.snapshot.install.state);
  const headerHeight = useHeaderHeight();
  const [picker, setPicker] = useState<Picker | null>(null);
  if (!preferences) {
    return <Screen edges={['top', 'left', 'right']}>{null}</Screen>;
  }
  const storageStatus =
    installState === 'installed' ? t('storage.statusReady')
    : installState === 'needsRepair' ? t('storage.statusNeedsRepair')
    : t('storage.statusNeedsSetup');
  const themeKey = THEMES.find(theme => theme.value === preferences.theme)?.key ?? 'settings.themeSystem';

  const choose = <K extends 'appLanguage' | 'responseLanguage' | 'theme'>(key: K, value: NonNullable<typeof preferences>[K]) => {
    setPicker(null);
    void services.setPreference(key, value).catch(() => undefined);
  };

  const pickerTitle =
    picker === 'appLanguage' ? t('settings.appLanguage')
    : picker === 'answerLanguage' ? t('settings.defaultResponseLanguage')
    : t('settings.appearance');
  const pickerItems: ActionSheetItem[] =
    picker === 'appLanguage'
      ? APP_LANGUAGES.map(language => ({
          key: language,
          label: t(`languageNames.${language}`),
          icon: 'language' as const,
          selected: preferences.appLanguage === language,
          testID: `settings-language-${language}`,
          onPress: () => choose('appLanguage', language),
        }))
      : picker === 'answerLanguage'
        ? // App language and answer language are independent (CTX-006).
          RESPONSE_LANGUAGES.map(language => ({
            key: language,
            label: t(`responseLanguage.${language}`),
            icon: 'translate' as const,
            selected: preferences.responseLanguage === language,
            testID: `settings-answer-language-${language}`,
            onPress: () => choose('responseLanguage', language),
          }))
        : picker === 'theme'
          ? THEMES.map(theme => ({
              key: theme.value,
              label: t(theme.key),
              icon: 'palette' as const,
              selected: preferences.theme === theme.value,
              testID: `settings-theme-${theme.value}`,
              onPress: () => choose('theme', theme.value),
            }))
          : [];

  return (
    <>
      <Screen edges={['left', 'right', 'bottom']} topInset={headerHeight} testID="settings-screen" contentStyle={{gap: spacing.xl}}>
        <ReturnToAnswerBanner />

        <SettingsGroup
          title={t('settings.sectionGeneral')}
          footer={`${t('settings.answerLanguage')}: ${t('settings.defaultResponseNote')}`}>
          <SettingsRow
            icon="language"
            kind="choose"
            title={t('settings.appLanguage')}
            value={t(`languageNames.${preferences.appLanguage}`)}
            onPress={() => setPicker('appLanguage')}
            testID="settings-app-language"
          />
          <SettingsRow
            icon="translate"
            kind="choose"
            title={t('settings.answerLanguage')}
            // The full wording ("Same as my message") is in the choice list.
            value={preferences.responseLanguage === 'auto' ? t('responseLanguage.autoShort') : t(`responseLanguage.${preferences.responseLanguage}`)}
            onPress={() => setPicker('answerLanguage')}
            testID="settings-answer-language"
          />
          <SettingsRow
            icon="palette"
            kind="choose"
            title={t('settings.appearance')}
            value={t(themeKey)}
            onPress={() => setPicker('theme')}
            testID="settings-appearance"
          />
        </SettingsGroup>

        <SettingsGroup title={t('settings.sectionData')}>
          <SettingsRow icon="sd_storage" title={t('settings.storage')} value={storageStatus} onPress={() => navigation.navigate('OfflineStorage')} testID="settings-storage" />
          <SettingsRow icon="shield" title={t('settings.privacy')} onPress={() => navigation.navigate('Privacy')} testID="settings-privacy" />
        </SettingsGroup>

        <SettingsGroup title={t('settings.sectionSupport')}>
          <SettingsRow icon="help" title={t('settings.help')} onPress={() => navigation.navigate('Help')} testID="settings-help" />
          <SettingsRow icon="info" title={t('settings.aboutAi')} onPress={() => navigation.navigate('AboutAi')} testID="settings-about" />
          <SettingsRow icon="smartphone" title={t('settings.version')} value={`${services.info.appVersion} (${services.info.appBuild})`} testID="settings-version" />
        </SettingsGroup>
        <View style={{height: spacing.sm}} />
      </Screen>

      <ActionSheet
        visible={picker !== null}
        title={pickerTitle}
        cancelLabel={t('common.cancel')}
        onDismiss={() => setPicker(null)}
        items={pickerItems}
      />
    </>
  );
}
