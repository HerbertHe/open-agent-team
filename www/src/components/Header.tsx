import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Moon, Sun, Globe } from 'lucide-react';

export function Header() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<'auto' | 'white' | 'light' | 'dark'>('auto');
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  const langMap: Record<string, string> = {
    'en': 'English',
    'zh-CN': '简体中文',
    'ja': '日本語',
    'fr': 'Français'
  };

  const THEME_CARDS = [
    { key: 'auto', label: 'Auto', colors: { bg: 'linear-gradient(135deg, #ffffff 0 50%, #111 50% 100%)', card: 'linear-gradient(135deg, #fff 0 50%, #1a1a1a 50% 100%)', border: '#bdbdbd', text: '#2d2a26', textMuted: 'linear-gradient(135deg, #c9c9c9 0 50%, #5a5a5a 50% 100%)' } },
    { key: 'white', label: 'White', colors: { bg: '#ffffff', card: '#ffffff', border: '#e5e5e5', text: '#2d2a26', textMuted: '#a29c95' } },
    { key: 'light', label: 'Light', colors: { bg: '#faf9f5', card: '#f0eee8', border: '#e3e1db', text: '#2d2a26', textMuted: '#a29c95' } },
    { key: 'dark', label: 'Dark', colors: { bg: '#151412', card: '#1d1b18', border: '#3a3530', text: '#f6f4f1', textMuted: '#9c958d' } },
  ];

  useEffect(() => {
    const saved = localStorage.getItem('oat-theme') || 'auto';
    setTheme(saved as 'auto' | 'white' | 'light' | 'dark');
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  const selectTheme = (newTheme: string) => {
    setTheme(newTheme as any);
    localStorage.setItem('oat-theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    setThemeMenuOpen(false);
  };

  const selectLang = (lang: string) => {
    i18n.changeLanguage(lang);
    setLangMenuOpen(false);
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/80 backdrop-blur">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <div className="flex gap-6 items-center">
          <Link to="/" className="font-bold text-lg tracking-tight flex items-center gap-2">
            <img src="/logo.svg" alt="OAT Logo" className="w-6 h-6" />
            <span>Open Agent Team</span>
          </Link>
          <nav className="hidden md:flex gap-2">
            <Link to="/docs" className="px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors rounded-md cursor-pointer">
              {t('nav.docs')}
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/HerbertHe/open-agent-team"
            target="_blank"
            rel="noreferrer"
            className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors rounded-md flex items-center gap-2 text-sm cursor-pointer"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path><path d="M9 18c-4.51 2-5-2-7-2"></path></svg>
            <span className="hidden sm:inline">{t('nav.github')}</span>
          </a>
          <div className="relative">
            <button 
              onClick={() => setLangMenuOpen(!langMenuOpen)}
              onBlur={() => setTimeout(() => setLangMenuOpen(false), 200)}
              className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted flex items-center gap-2 cursor-pointer" 
              title="Switch Language"
            >
              <Globe size={18} />
              <span className="hidden sm:inline text-sm">{langMap[i18n.language] || 'English'}</span>
            </button>
            {langMenuOpen && (
              <div className="absolute top-full right-0 mt-1 w-32 bg-card border border-border rounded-md shadow-lg py-1 flex flex-col z-50">
                {Object.entries(langMap).map(([code, label]) => (
                  <button
                    key={code}
                    onClick={() => selectLang(code)}
                    className={`px-4 py-2 text-sm text-left hover:bg-muted transition-colors cursor-pointer ${i18n.language === code ? 'text-foreground font-bold' : 'text-muted-foreground'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button 
              onClick={() => setThemeMenuOpen(!themeMenuOpen)}
              onBlur={() => setTimeout(() => setThemeMenuOpen(false), 200)}
              className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted cursor-pointer" 
              title="Toggle Theme"
            >
              {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            {themeMenuOpen && (
              <div className="absolute top-full right-0 mt-1 bg-card border border-border rounded-md shadow-lg z-50 theme-menu-popover">
                {THEME_CARDS.map((tc) => (
                  <button
                    key={tc.key}
                    onClick={() => selectTheme(tc.key)}
                    className={`theme-card cursor-pointer ${theme === tc.key ? 'active' : ''}`}
                    title={t(`theme.${tc.key}`, tc.label)}
                  >
                    <div className="theme-card-preview" style={{ background: tc.colors.bg, border: `1px solid ${tc.colors.border}` }}>
                      <div className="theme-card-header" style={{ background: tc.colors.card, borderBottom: `1px solid ${tc.colors.border}` }} />
                      <div className="theme-card-body">
                        <div className="theme-card-sidebar" style={{ background: tc.colors.card, borderRight: `1px solid ${tc.colors.border}` }} />
                        <div className="theme-card-content" style={{ background: tc.colors.bg }}>
                          <div className="theme-card-line" style={{ background: tc.colors.textMuted }} />
                          <div className="theme-card-line short" style={{ background: tc.colors.textMuted }} />
                        </div>
                      </div>
                    </div>
                    <span className="theme-card-label">{t(`theme.${tc.key}`, tc.label)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
