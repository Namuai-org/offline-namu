import i18next from 'i18next';
import {initReactI18next} from 'react-i18next';
import type {AppLanguage} from '../data/repositories/PreferencesRepository';
import en from './en.json';
import fr from './fr.json';
import ha from './ha.json';

/**
 * LOC-001: bundled JSON resources only — no remote loading, no language
 * detection downloads (CTX-006). English is the development fallback; release
 * requires every key translated and reviewed (check-locales.js --release).
 */
export const i18n = i18next.createInstance();

export async function initI18n(language: AppLanguage): Promise<void> {
  if (i18n.isInitialized) {
    await i18n.changeLanguage(language);
    return;
  }
  await i18n.use(initReactI18next).init({
    resources: {en: {translation: en}, fr: {translation: fr}, ha: {translation: ha}},
    lng: language,
    fallbackLng: 'en',
    supportedLngs: ['en', 'fr', 'ha'],
    interpolation: {escapeValue: false},
    returnNull: false,
    react: {useSuspense: false},
  });
}

export function setAppLanguage(language: AppLanguage): Promise<unknown> {
  return i18n.changeLanguage(language);
}
