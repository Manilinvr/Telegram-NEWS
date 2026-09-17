import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useCurrentUser } from './api/hooks.js';
import { ApiError } from './api/client.js';
import { LoginPage } from './pages/LoginPage.jsx';
import { Shell } from './components/layout/Shell.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { FeedPage } from './pages/FeedPage.jsx';
import { ModerationPage } from './pages/ModerationPage.jsx';
import { SourcesPage } from './pages/SourcesPage.jsx';
import { AnalyticsPage } from './pages/AnalyticsPage.jsx';
import { SettingsPage } from './pages/SettingsPage.jsx';
import { MapPage } from './pages/MapPage.jsx';
import { PublishedPage } from './pages/PublishedPage.jsx';

/**
 * Корневой компонент.
 *
 * Панель полностью закрыта: без действующей сессии показывается только
 * экран входа, маршрута регистрации не существует (ТЗ §22).
 */
export function App() {
  const { data: user, isLoading, error, refetch } = useCurrentUser();
  const [justLoggedIn, setJustLoggedIn] = useState(false);

  if (isLoading) {
    return (
      <div className="auth">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)' }}>
          <span className="spinner" />
          Проверка сессии…
        </div>
      </div>
    );
  }

  const unauthorized = !user || (error instanceof ApiError && error.isUnauthorized);

  if (unauthorized && !justLoggedIn) {
    return (
      <LoginPage
        onSuccess={() => {
          setJustLoggedIn(true);
          void refetch();
        }}
      />
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/feed" element={<FeedPage />} />
        <Route path="/events" element={<FeedPage eventsOnly />} />
        <Route path="/moderation" element={<ModerationPage />} />
        <Route path="/published" element={<PublishedPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/sources" element={<SourcesPage />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
