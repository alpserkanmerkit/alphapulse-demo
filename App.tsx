import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import Sidebar from './components/Sidebar';
import DashboardPage from './pages/DashboardPage';
import { useNewsStore } from './stores/newsStore';
import { AuthGate } from './components/auth/AuthGate';
import { NEWS_QUERY_KEY } from './hooks/queries/useNewsQueries';

const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const WarRoomPage = lazy(() => import('./pages/WarRoomPage'));
const CompliancePage = lazy(() => import('./pages/CompliancePage'));
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 60 * 1000,
    },
  },
});

const RouteFallback: React.FC = () => (
  <div style={{ padding: 24 }}>
    <div className="ap-card" style={{ padding: 16 }}>
      Loading module...
    </div>
  </div>
);

const AppContent: React.FC = () => {
  const { isStreamActive, refreshRuntimeStatus } = useNewsStore();
  const activeQueryClient = useQueryClient();

  useEffect(() => {
    void refreshRuntimeStatus();
  }, [refreshRuntimeStatus]);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    if (isStreamActive && import.meta.env.VITE_API_BASE_URL) {
      eventSource = new EventSource(`${import.meta.env.VITE_API_BASE_URL}/api/news/stream`);
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'update') {
          void activeQueryClient.invalidateQueries({ queryKey: NEWS_QUERY_KEY });
        }
      };
    }
    return () => {
      eventSource?.close();
    };
  }, [activeQueryClient, isStreamActive]);

  useEffect(() => {
    const refresh = () => {
      void refreshRuntimeStatus();
    };

    const runtimeInterval = setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);

    return () => {
      clearInterval(runtimeInterval);
      window.removeEventListener('focus', refresh);
    };
  }, [refreshRuntimeStatus]);

  return (
    <div className="ap-shell">
      <Sidebar />
      <div className="ap-main">
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/war-room" element={<WarRoomPage />} />
            <Route path="/compliance" element={<CompliancePage />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
};

const App: React.FC = () => (
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthGate>
        <AppContent />
      </AuthGate>
    </BrowserRouter>
    <ReactQueryDevtools initialIsOpen={false} />
  </QueryClientProvider>
);

export default App;
