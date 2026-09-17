import type { ReactNode } from 'react';
import type { DashboardSummary } from '@nnm/shared';
import { StatTile } from '../ui/primitives.jsx';
import { IconMenu } from '../ui/Icons.jsx';
import { useClock } from '../../lib/useLive.js';

/**
 * Верхняя панель: название, состояние потока и ключевые показатели.
 * Часы идут в московском времени — по нему живёт город и источники.
 */
export function TopBar({
  title,
  subtitle,
  summary,
  live,
  onMenuClick,
  actions,
}: {
  title: string;
  subtitle: string;
  summary?: DashboardSummary;
  live: boolean;
  onMenuClick: () => void;
  actions?: ReactNode;
}) {
  const now = useClock();

  return (
    <header className="topbar">
      <button type="button" className="menu-toggle" onClick={onMenuClick} aria-label="Открыть меню">
        <IconMenu size={18} />
      </button>

      <div className="topbar__heading">
        <div className="topbar__title-row">
          <h1 className="topbar__title">{title}</h1>
          <span className={`live-badge${live ? '' : ' live-badge--offline'}`}>
            <span className="live-badge__dot" />
            {live ? 'LIVE' : 'ОФФЛАЙН'}
          </span>
        </div>
        <p className="topbar__subtitle">{subtitle}</p>
      </div>

      {summary && (
        <div className="topbar__stats">
          <StatTile label="Источников" value={summary.sources.active} />
          <StatTile
            label="Постов за сутки"
            value={summary.posts.last24h}
            delta={summary.posts.deltaVsPrev24h}
          />
          <StatTile
            label="События"
            value={summary.events.last24h}
            delta={summary.events.deltaVsPrev24h}
          />
        </div>
      )}

      {actions && <div className="panel__actions">{actions}</div>}

      <div className="topbar__clock">
        <div className="topbar__date">
          {now.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'Europe/Moscow',
          })}
        </div>
        <div className="topbar__time">
          {now.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Moscow',
          })}
        </div>
      </div>
    </header>
  );
}
