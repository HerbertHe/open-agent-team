import { createHashRouter } from 'react-router-dom';
import React, { Suspense } from 'react';
import { Spin } from 'antd';
import { MainLayout } from '../components/layout/MainLayout';

const DashboardPage = React.lazy(() => import('../pages/DashboardPage').then(module => ({ default: module.DashboardPage })));
const ObservabilityPage = React.lazy(() => import('../pages/ObservabilityPage').then(module => ({ default: module.ObservabilityPage })));
const TeamConfigPage = React.lazy(() => import('../pages/TeamConfigPage').then(module => ({ default: module.TeamConfigPage })));
const SettingsPage = React.lazy(() => import('../pages/SettingsPage').then(module => ({ default: module.SettingsPage })));
const UsageStatsPage = React.lazy(() => import('../pages/UsageStatsPage').then(module => ({ default: module.UsageStatsPage })));
const ProjectAchievementsPage = React.lazy(() => import('../pages/ProjectAchievementsPage').then(module => ({ default: module.ProjectAchievementsPage })));
const PluginsPage = React.lazy(() => import('../pages/PluginsPage').then(module => ({ default: module.PluginsPage })));
const ChannelsPage = React.lazy(() => import('../pages/ChannelsPage').then(module => ({ default: module.ChannelsPage })));

const SuspendedPage = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', padding: '40px' }}><Spin size="large" /></div>}>
    {children}
  </Suspense>
);

export const router = createHashRouter([
  {
    element: <MainLayout />,
    children: [
      { path: '/', element: <SuspendedPage><DashboardPage /></SuspendedPage> },
      { path: '/observability', element: <SuspendedPage><ObservabilityPage /></SuspendedPage> },
      { path: '/team-config', element: <SuspendedPage><TeamConfigPage /></SuspendedPage> },
      { path: '/usage', element: <SuspendedPage><UsageStatsPage /></SuspendedPage> },
      { path: '/achievements', element: <SuspendedPage><ProjectAchievementsPage /></SuspendedPage> },
      { path: '/plugins', element: <SuspendedPage><PluginsPage /></SuspendedPage> },
      { path: '/channels', element: <SuspendedPage><ChannelsPage /></SuspendedPage> },
      { path: '/settings', element: <SuspendedPage><SettingsPage /></SuspendedPage> },
    ],
  },
]);
