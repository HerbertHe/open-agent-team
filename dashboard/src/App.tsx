import { useEffect, useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';
import { ConfigProvider, App as AntdApp, theme } from 'antd';
import { XProvider } from '@ant-design/x';
import { useThemeStore } from './stores';
import { router } from './router';
import './i18n';
import './App.less';

/* ── CPAMC 调色板 — 与 themes.less 精确对应 ── */
const LIGHT_TOKENS = {
  colorPrimary: '#8b8680',
  colorSuccess: '#10b981',
  colorWarning: '#e0aa14',
  colorError: '#c65746',
  colorInfo: '#8b8680',
  colorText: '#2d2a26',
  colorTextSecondary: '#6d6760',
  colorTextTertiary: '#a29c95',
  colorTextQuaternary: '#c0bab3',
  colorBgContainer: '#f0eee8',
  colorBgElevated: '#fffdf9',
  colorBgLayout: '#faf9f5',
  colorBgSpotlight: '#e9e6df',
  colorBorder: '#e3e1db',
  colorBorderSecondary: '#e3e1db',
  colorFillSecondary: 'rgba(139,134,128,0.08)',
  colorFillTertiary: 'rgba(139,134,128,0.04)',
  colorFillQuaternary: 'rgba(139,134,128,0.02)',
  colorSplit: '#e3e1db',
  controlItemBgActive: 'rgba(139,134,128,0.15)',
  controlItemBgHover: '#e9e6df',
  colorPrimaryBg: 'rgba(139,134,128,0.08)',
  colorPrimaryBgHover: 'rgba(139,134,128,0.12)',
  colorPrimaryBorder: '#c0bab3',
  colorPrimaryBorderHover: '#a29c95',
  colorPrimaryHover: '#7f7a74',
  colorPrimaryActive: '#726d67',
  colorPrimaryTextHover: '#7f7a74',
  colorPrimaryTextActive: '#726d67',
  colorPrimaryText: '#8b8680',
  colorLink: '#8b8680',
  colorLinkHover: '#7f7a74',
  colorLinkActive: '#726d67',
  colorErrorBg: 'rgba(198,87,70,0.1)',
  colorErrorBorder: 'rgba(198,87,70,0.35)',
  colorSuccessBg: '#d1fae5',
  colorSuccessBorder: '#6ee7b7',
};

const DARK_TOKENS = {
  colorPrimary: '#8b8680',
  colorSuccess: '#10b981',
  colorWarning: '#ffd862',
  colorError: '#c65746',
  colorInfo: '#8b8680',
  colorText: '#f6f4f1',
  colorTextSecondary: '#c9c3bb',
  colorTextTertiary: '#9c958d',
  colorTextQuaternary: '#6f6962',
  colorBgContainer: '#1d1b18',
  colorBgElevated: '#2a2723',
  colorBgLayout: '#151412',
  colorBgSpotlight: '#262320',
  colorBorder: '#3a3530',
  colorBorderSecondary: '#3a3530',
  colorFillSecondary: 'rgba(139,134,128,0.12)',
  colorFillTertiary: 'rgba(139,134,128,0.08)',
  colorFillQuaternary: 'rgba(139,134,128,0.04)',
  colorSplit: '#3a3530',
  controlItemBgActive: 'rgba(139,134,128,0.22)',
  controlItemBgHover: '#2e2a26',
  colorPrimaryBg: 'rgba(139,134,128,0.12)',
  colorPrimaryBgHover: 'rgba(139,134,128,0.18)',
  colorPrimaryBorder: '#6f6962',
  colorPrimaryBorderHover: '#9c958d',
  colorPrimaryHover: '#9a948e',
  colorPrimaryActive: '#a6a099',
  colorPrimaryTextHover: '#9a948e',
  colorPrimaryTextActive: '#a6a099',
  colorPrimaryText: '#8b8680',
  colorLink: '#9a948e',
  colorLinkHover: '#a6a099',
  colorLinkActive: '#8b8680',
  colorErrorBg: 'rgba(198,87,70,0.18)',
  colorErrorBorder: 'rgba(198,87,70,0.45)',
  colorSuccessBg: 'rgba(6,78,59,0.3)',
  colorSuccessBorder: '#059669',
};

const COMPONENT_TOKENS = {
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  fontFamily:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  fontSize: 14,
  wireframe: false,
};

export default function App() {
  const currentTheme = useThemeStore((s) => s.theme);
  const initializeTheme = useThemeStore((s) => s.initializeTheme);

  useEffect(() => {
    const cleanup = initializeTheme();
    return cleanup;
  }, [initializeTheme]);

  const isDark =
    currentTheme === 'dark' ||
    (currentTheme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const antdTheme = useMemo(
    () => ({
      algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        ...(isDark ? DARK_TOKENS : LIGHT_TOKENS),
        ...COMPONENT_TOKENS,
      },
      components: {
        Card: {
          colorBgContainer: isDark ? '#1d1b18' : '#f0eee8',
          colorBorderSecondary: isDark ? '#3a3530' : '#e3e1db',
          borderRadiusLG: 12,
        },
        Table: {
          colorBgContainer: isDark ? '#1d1b18' : '#f0eee8',
          headerBg: isDark ? '#262320' : '#e9e6df',
          headerColor: isDark ? '#c9c3bb' : '#6d6760',
          rowHoverBg: isDark ? '#2e2a26' : '#e9e6df',
          borderColor: isDark ? '#3a3530' : '#e3e1db',
        },
        Button: {
          colorPrimary: '#8b8680',
          colorPrimaryHover: isDark ? '#9a948e' : '#7f7a74',
          colorPrimaryActive: isDark ? '#a6a099' : '#726d67',
          primaryColor: '#ffffff',
          defaultBg: isDark ? '#262320' : '#f0eee8',
          defaultBorderColor: isDark ? '#3a3530' : '#e3e1db',
          defaultColor: isDark ? '#f6f4f1' : '#2d2a26',
          defaultHoverBg: isDark ? '#2e2a26' : '#e9e6df',
          defaultHoverBorderColor: isDark ? '#5a544d' : '#cecac4',
          defaultHoverColor: isDark ? '#f6f4f1' : '#2d2a26',
          borderRadius: 8,
        },
        Input: {
          colorBgContainer: isDark ? '#262320' : '#faf9f5',
          activeBorderColor: '#8b8680',
          hoverBorderColor: isDark ? '#5a544d' : '#cecac4',
        },
        InputNumber: {
          colorBgContainer: isDark ? '#262320' : '#faf9f5',
          activeBorderColor: '#8b8680',
          hoverBorderColor: isDark ? '#5a544d' : '#cecac4',
        },
        Select: {
          colorBgContainer: isDark ? '#262320' : '#faf9f5',
          colorBgElevated: isDark ? '#2a2723' : '#fffdf9',
          optionActiveBg: isDark ? 'rgba(139,134,128,0.22)' : 'rgba(139,134,128,0.15)',
          optionSelectedBg: isDark ? 'rgba(139,134,128,0.28)' : 'rgba(139,134,128,0.18)',
        },
        Tag: {
          defaultBg: isDark ? '#262320' : '#e9e6df',
          defaultColor: isDark ? '#c9c3bb' : '#6d6760',
        },
        Descriptions: {
          labelBg: isDark ? '#262320' : '#e9e6df',
          titleColor: isDark ? '#f6f4f1' : '#2d2a26',
        },
        Modal: {
          contentBg: isDark ? '#1d1b18' : '#fffdf9',
          headerBg: isDark ? '#1d1b18' : '#fffdf9',
          titleColor: isDark ? '#f6f4f1' : '#2d2a26',
          colorIcon: isDark ? '#9c958d' : '#a29c95',
          colorIconHover: isDark ? '#c9c3bb' : '#6d6760',
          footerBg: 'transparent',
        },
        Message: {
          contentBg: isDark ? '#2a2723' : '#fffdf9',
          contentPaddingBlock: 10,
          contentPaddingInline: 16,
        },
        Notification: {
          colorBgElevated: isDark ? '#2a2723' : '#fffdf9',
        },
        Spin: {
          colorPrimary: '#8b8680',
        },
        Tabs: {
          inkBarColor: '#8b8680',
          itemActiveColor: isDark ? '#f6f4f1' : '#2d2a26',
          itemHoverColor: isDark ? '#c9c3bb' : '#6d6760',
          itemSelectedColor: isDark ? '#f6f4f1' : '#2d2a26',
        },
        Tooltip: {
          colorBgSpotlight: isDark ? '#2a2723' : '#2d2a26',
          colorTextLightSolid: isDark ? '#f6f4f1' : '#ffffff',
        },
      },
    }),
    [isDark],
  );

  return (
    <ConfigProvider theme={antdTheme}>
      <AntdApp>
        <XProvider>
          <RouterProvider router={router} />
        </XProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
