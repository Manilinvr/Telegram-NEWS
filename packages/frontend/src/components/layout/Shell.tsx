import { useMemo, useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar.jsx';
import { useDashboard, useProcessingErrors } from '../../api/hooks.js';
import { useLiveUpdates } from '../../lib/useLive.js';
import { LiveContext } from '../../lib/live-context.js';

/** Каркас панели: навигация, поток живых обновлений и рабочая область. */
export function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { connected } = useLiveUpdates(true);
  const { data: dashboard } = useDashboard('24h');
  const { data: errors } = useProcessingErrors();

  const summary = dashboard?.summary;

  const contextValue = useMemo(
    () => ({ connected, openMenu: () => setMenuOpen(true) }),
    [connected],
  );

  return (
    <LiveContext.Provider value={contextValue}>
      <div className="shell">
        <Sidebar
          open={menuOpen}
          onNavigate={() => setMenuOpen(false)}
          badges={{
            moderation: summary?.moderation.pending ?? 0,
            errors: errors?.length ?? 0,
          }}
          status={{
            healthy: (summary?.sources.failing ?? 0) === 0 && (summary?.errors.unresolved ?? 0) === 0,
            degraded: (summary?.errors.unresolved ?? 0) > 0,
            updatedAt: summary?.generatedAt ?? null,
          }}
        />

        {menuOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            onClick={() => setMenuOpen(false)}
            aria-label="Закрыть меню"
          />
        )}

        <div className="main">{children}</div>
      </div>
    </LiveContext.Provider>
  );
}
