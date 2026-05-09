import { create } from 'zustand';
import i18n from '../i18n';

export type Language = 'en' | 'zh-CN' | 'fr' | 'ja';

function detectDefaultLang(): Language {
  const stored = localStorage.getItem('oat-language') as Language | null;
  if (stored) return stored;
  const nav = navigator.language;
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('ja')) return 'ja';
  return 'en';
}

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: detectDefaultLang(),

  setLanguage: (lang: Language) => {
    localStorage.setItem('oat-language', lang);
    void i18n.changeLanguage(lang);
    document.documentElement.lang = lang;
    set({ language: lang });
  },
}));
