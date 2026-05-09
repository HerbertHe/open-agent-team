import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import zhCN from './locales/zh-CN';
import fr from './locales/fr';
import ja from './locales/ja';

const storedLang = localStorage.getItem('oat-language');

function detectDefaultLang(): string {
  if (storedLang) return storedLang;
  const nav = navigator.language;
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('ja')) return 'ja';
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-CN': { translation: zhCN },
    fr: { translation: fr },
    ja: { translation: ja },
  },
  lng: detectDefaultLang(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
