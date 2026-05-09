import { create } from 'zustand';

export type Theme = 'auto' | 'white' | 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  initializeTheme: () => (() => void);
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: (localStorage.getItem('oat-theme') as Theme) || 'auto',

  setTheme: (theme: Theme) => {
    localStorage.setItem('oat-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  initializeTheme: () => {
    const stored = (localStorage.getItem('oat-theme') as Theme) || 'auto';
    document.documentElement.setAttribute('data-theme', stored);
    set({ theme: stored });

    // Listen to OS preference changes for 'auto' theme
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const current = localStorage.getItem('oat-theme') as Theme;
      if (current === 'auto') {
        // Force a re-render to pick up new media query state
        set({ theme: 'auto' });
      }
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  },
}));
