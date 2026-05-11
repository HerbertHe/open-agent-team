import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThemeStore, useLanguageStore, type Theme } from '../../stores';
import styles from './MainLayout.module.less';

/* ---- SVG icon helpers ---- */
const iconProps = {
  width: 18, height: 18, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const smallIconProps = { ...iconProps, width: 16, height: 16 };

const icons = {
  dashboard: <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  observability: <svg {...iconProps}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>,
  teamConfig: <svg {...iconProps}><path d="M4 21v-7" /><path d="M4 10V3" /><path d="M12 21v-9" /><path d="M12 8V3" /><path d="M20 21v-5" /><path d="M20 12V3" /><path d="M1 14h6" /><path d="M9 8h6" /><path d="M17 16h6" /></svg>,
  chevronLeft: <svg {...smallIconProps}><path d="m14 18-6-6 6-6" /></svg>,
  chevronRight: <svg {...smallIconProps}><path d="m10 6 6 6-6 6" /></svg>,
  menu: <svg {...smallIconProps}><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></svg>,
  close: <svg {...smallIconProps}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>,
  language: <svg {...smallIconProps}><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>,
  sun: <svg {...smallIconProps}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>,
  moon: <svg {...smallIconProps}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" /></svg>,
  settings: <svg {...smallIconProps}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>,
};

const THEME_CARDS: Array<{
  key: Theme;
  labelKey: string;
  colors: { bg: string; card: string; border: string; text: string; textMuted: string };
}> = [
  { key: 'auto', labelKey: 'theme.auto', colors: { bg: 'linear-gradient(135deg, #ffffff 0 50%, #111 50% 100%)', card: 'linear-gradient(135deg, #fff 0 50%, #1a1a1a 50% 100%)', border: '#bdbdbd', text: '#2d2a26', textMuted: 'linear-gradient(135deg, #c9c9c9 0 50%, #5a5a5a 50% 100%)' } },
  { key: 'white', labelKey: 'theme.white', colors: { bg: '#ffffff', card: '#ffffff', border: '#e5e5e5', text: '#2d2a26', textMuted: '#a29c95' } },
  { key: 'light', labelKey: 'theme.light', colors: { bg: '#faf9f5', card: '#f0eee8', border: '#e3e1db', text: '#2d2a26', textMuted: '#a29c95' } },
  { key: 'dark', labelKey: 'theme.dark', colors: { bg: '#151412', card: '#1d1b18', border: '#3a3530', text: '#f6f4f1', textMuted: '#9c958d' } },
];

const LANGUAGES = [
  { code: 'en' as const, labelKey: 'language.en' },
  { code: 'zh-CN' as const, labelKey: 'language.zh-CN' },
  { code: 'fr' as const, labelKey: 'language.fr' },
  { code: 'ja' as const, labelKey: 'language.ja' },
];

const sidebarNavIcons: Record<string, ReactNode> = {
  '/': icons.dashboard,
  '/observability': icons.observability,
  '/team-config': icons.teamConfig,
  '/settings': icons.settings,
};

export function MainLayout() {
  const { t } = useTranslation();
  const location = useLocation();

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const initializeTheme = useThemeStore((s) => s.initializeTheme);
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  const langMenuRef = useRef<HTMLDivElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanup = initializeTheme();
    return cleanup;
  }, [initializeTheme]);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langMenuOpen && langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
      if (themeMenuOpen && themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [langMenuOpen, themeMenuOpen]);

  // Close mobile sidebar on route change
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const toggleLangMenu = useCallback(() => {
    setLangMenuOpen((p) => !p);
    setThemeMenuOpen(false);
  }, []);

  const toggleThemeMenu = useCallback(() => {
    setThemeMenuOpen((p) => !p);
    setLangMenuOpen(false);
  }, []);

  const navItems = [
    { path: '/', label: t('nav.dashboard') },
    { path: '/observability', label: t('nav.observability') },
    { path: '/team-config', label: t('nav.team_config') },
    { path: '/settings', label: t('nav.settings') },
  ];

  const showLabels = !sidebarCollapsed || sidebarOpen;

  return (
    <div className={`${styles['app-shell']} ${sidebarCollapsed ? styles['sidebar-is-collapsed'] : ''}`}>
      {/* Top gradient blur — matches CPAMC */}
      <div className={styles['top-gradient-blur']} />

      {/* Header */}
      <header className={styles['main-header']}>
        <button
          type="button"
          className={styles['sidebar-toggle-floating']}
          onClick={() => setSidebarCollapsed((p) => !p)}
          title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          {sidebarCollapsed ? icons.chevronRight : icons.chevronLeft}
        </button>

        <div className={styles['mobile-sidebar-actions']}>
          <button type="button" className={styles['header-btn']} onClick={() => setSidebarOpen((p) => !p)}>
            {sidebarOpen ? icons.close : icons.menu}
          </button>
        </div>

        <div className={styles['header-actions']}>
          {/* Language menu */}
          <div className={styles['menu-container']} ref={langMenuRef}>
            <button type="button" className={styles['header-btn']} onClick={toggleLangMenu} title={t('language.switch')}>
              {icons.language}
            </button>
            {langMenuOpen && (
              <div className={styles['menu-popover']}>
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    className={`${styles['menu-option']} ${language === lang.code ? styles['active'] : ''}`}
                    onClick={() => { setLanguage(lang.code); setLangMenuOpen(false); }}
                  >
                    <span>{t(lang.labelKey)}</span>
                    {language === lang.code && <span className={styles['menu-check']}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme menu */}
          <div className={styles['menu-container']} ref={themeMenuRef}>
            <button type="button" className={styles['header-btn']} onClick={toggleThemeMenu} title={t('theme.switch')}>
              {theme === 'dark' ? icons.moon : icons.sun}
            </button>
            {themeMenuOpen && (
              <div className={`${styles['menu-popover']} ${styles['theme-menu-popover']}`}>
                {THEME_CARDS.map((tc) => (
                  <button
                    key={tc.key}
                    type="button"
                    className={`${styles['theme-card']} ${theme === tc.key ? styles['active'] : ''}`}
                    onClick={() => { setTheme(tc.key); setThemeMenuOpen(false); }}
                  >
                    <div className={styles['theme-card-preview']} style={{ background: tc.colors.bg, border: `1px solid ${tc.colors.border}` }}>
                      <div className={styles['theme-card-header']} style={{ background: tc.colors.card, borderBottom: `1px solid ${tc.colors.border}` }} />
                      <div className={styles['theme-card-body']}>
                        <div className={styles['theme-card-sidebar']} style={{ background: tc.colors.card, borderRight: `1px solid ${tc.colors.border}` }} />
                        <div className={styles['theme-card-content']} style={{ background: tc.colors.bg }}>
                          <div className={styles['theme-card-line']} style={{ background: tc.colors.textMuted }} />
                          <div className={`${styles['theme-card-line']} ${styles['short']}`} style={{ background: tc.colors.textMuted }} />
                        </div>
                      </div>
                    </div>
                    <span className={styles['theme-card-label']}>{t(tc.labelKey)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <div className={styles['main-body']}>
        <button
          type="button"
          className={`${styles['sidebar-backdrop']} ${sidebarOpen ? styles['visible'] : ''}`}
          onClick={() => setSidebarOpen(false)}
          aria-label={t('common.close')}
          tabIndex={sidebarOpen ? 0 : -1}
        />

        <aside className={`${styles['sidebar']} ${sidebarOpen ? styles['open'] : ''} ${sidebarCollapsed ? styles['collapsed'] : ''}`}>
          <div className={styles['sidebar-brand']} title={t('sidebar.brand')}>
            <div className={styles['sidebar-brand-logo']}>O</div>
            {showLabels && <span className={styles['sidebar-brand-title']}>{t('sidebar.brand')}</span>}
          </div>

          <div className={styles['nav-section']}>
            {navItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => `${styles['nav-item']} ${isActive ? styles['active'] : ''}`}
                title={showLabels ? undefined : item.label}
              >
                <span className={styles['nav-icon']}>{sidebarNavIcons[item.path]}</span>
                {showLabels && <span className={styles['nav-label']}>{item.label}</span>}
              </NavLink>
            ))}
          </div>
        </aside>

        <div className={styles['content']}>
          <main className={styles['main-content']}>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
