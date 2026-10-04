import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@chh/shared/i18n/en.json';

/** All user-facing strings live in packages/shared/src/i18n/<lang>.json. */
export async function initI18n(language: string): Promise<void> {
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en } },
    lng: language,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}
