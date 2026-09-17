import React, {useState} from 'react';
import {Image, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {useAppStore} from '../../app/stores';
import {APP_LANGUAGES, type AppLanguage} from '../../data/repositories/PreferencesRepository';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuText} from '../../design/components/NamuText';
import {ChoiceRow} from '../../design/components/Rows';
import {Screen} from '../../design/components/Screen';
import {NamuIcon, type IconName} from '../../design/icons/NamuIcon';
import {useNamuTheme} from '../../design/theme';
import {spacing} from '../../design/tokens';

const logoDark = require('../../design/assets/namu-logo-dark.png');
const logoLight = require('../../design/assets/namu-logo-light.png');

/**
 * S01 — Language and introduction. No account screen (PRD-005). The device
 * locale is preselected only when supported (DB-003).
 */
export function OnboardingScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useNamuTheme();
  const navigation = useNavigation();
  const services = useServices();
  const current = useAppStore(s => s.preferences?.appLanguage ?? 'en');
  const [step, setStep] = useState<'language' | 'intro'>('language');

  const chooseLanguage = (language: AppLanguage) => {
    void services.setPreference('appLanguage', language);
  };

  const finish = async () => {
    await services.setPreference('onboardingComplete', true);
    navigation.reset({index: 1, routes: [{name: 'Tabs'}, {name: 'Setup'}]});
  };

  const wordmark = (
    <Image
      source={theme.dark ? logoLight : logoDark}
      accessibilityRole="image"
      accessibilityLabel="Namu"
      resizeMode="contain"
      style={{width: 240, height: 87, alignSelf: 'flex-start'}}
    />
  );

  if (step === 'language') {
    return (
      <Screen
        edges={['top', 'bottom', 'left', 'right']}
        testID="onboarding-language"
        footer={<NamuButton label={t('common.continue')} onPress={() => setStep('intro')} testID="onboarding-continue" />}>
        {wordmark}
        <NamuText tone="secondary">{t('intro.tagline')}</NamuText>
        <NamuText variant="title" accessibilityRole="header" style={{marginTop: spacing.xl}}>
          {t('intro.chooseLanguage')}
        </NamuText>
        <View accessibilityRole="radiogroup" style={{gap: spacing.sm}}>
          {APP_LANGUAGES.map(language => (
            <ChoiceRow
              key={language}
              testID={`language-${language}`}
              title={t(`languageNames.${language}`)}
              selected={current === language}
              onPress={() => chooseLanguage(language)}
            />
          ))}
        </View>
      </Screen>
    );
  }

  const points: {icon: IconName; text: string}[] = [
    {icon: 'download', text: t('intro.pointDownload')},
    {icon: 'smartphone', text: t('intro.pointOnDevice')},
    {icon: 'info', text: t('intro.pointMistakes')},
  ];
  return (
    <Screen
      edges={['top', 'bottom', 'left', 'right']}
      testID="onboarding-intro"
      footer={
        <>
          <NamuButton label={t('intro.start')} onPress={finish} testID="onboarding-start" />
          <NamuButton label={t('common.back')} variant="text" onPress={() => setStep('language')} />
        </>
      }>
      {wordmark}
      <NamuText variant="title" accessibilityRole="header" style={{marginTop: spacing.lg}}>
        {t('intro.aboutTitle')}
      </NamuText>
      <View style={{gap: spacing.lg, marginVertical: spacing.md}}>
        {points.map(point => (
          <View key={point.icon} style={{flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start'}}>
            <NamuIcon name={point.icon} color={theme.colors.action} />
            <NamuText style={{flex: 1}}>{point.text}</NamuText>
          </View>
        ))}
      </View>
      <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}}>
        <NamuButton label={t('intro.privacyLink')} variant="text" icon="shield" onPress={() => navigation.navigate('Privacy')} />
        <NamuButton label={t('intro.aboutLink')} variant="text" icon="info" onPress={() => navigation.navigate('AboutAi')} />
      </View>
    </Screen>
  );
}
