import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout } from './components/layout';
import { ApiError, UNAUTHORIZED_EVENT } from './lib/api';
import { ME_KEY, MeProvider, useMeQuery } from './lib/auth';
import { LayersPage } from './pages/flow';
import { LoginPage } from './pages/login';
import { AnalyticsPage, AuditPage, QueuePage } from './pages/ops';
import { ProjectPage } from './pages/project';
import { ProjectsPage } from './pages/projects';
import { ResourcePage } from './pages/resource';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 2000 } } });

const router = createBrowserRouter([
  {
    path: '/',
    Component: Layout,
    children: [
      { index: true, Component: ProjectsPage },
      { path: 'projects/:slug', Component: ProjectPage },
      { path: 'resources/:id', Component: ResourcePage },
      { path: 'layers', Component: LayersPage },
      { path: 'queue', Component: QueuePage },
      { path: 'analytics', Component: AnalyticsPage },
      { path: 'audit', Component: AuditPage },
      { path: 'login', Component: () => <Navigate to="/" replace /> },
    ],
  },
]);

/** The app renders only behind a session; a 401 anywhere drops back to the login page. */
const AuthGate = () => {
  const me = useMeQuery();
  useEffect(() => {
    const onUnauthorized = () => void queryClient.invalidateQueries({ queryKey: ME_KEY });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);
  if (me.isPending) return null;
  if (!me.data) {
    if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
    return <div className="p-6 text-sm text-destructive">{me.error instanceof Error ? me.error.message : 'Could not reach the server'}</div>;
  }
  return (
    <MeProvider me={me.data}>
      <RouterProvider router={router} />
    </MeProvider>
  );
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>
  </StrictMode>,
);
