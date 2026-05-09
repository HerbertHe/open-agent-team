import { createHashRouter } from 'react-router-dom';
import { MainLayout } from '../components/layout/MainLayout';
import { DashboardPage } from '../pages/DashboardPage';
import { ObservabilityPage } from '../pages/ObservabilityPage';
import { TeamConfigPage } from '../pages/TeamConfigPage';
import { SettingsPage } from '../pages/SettingsPage';

export const router = createHashRouter([
  {
    element: <MainLayout />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/observability', element: <ObservabilityPage /> },
      { path: '/team-config', element: <TeamConfigPage /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);
