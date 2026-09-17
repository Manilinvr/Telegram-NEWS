import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  IconAnalytics,
  IconEvents,
  IconFeed,
  IconHome,
  IconMap,
  IconModeration,
  IconPublished,
  IconSettings,
  IconSources,
} from '../ui/Icons.jsx';
import { formatTime } from '../../lib/format.js';

interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  badgeKey?: 'moderation' | 'errors';
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Главная', icon: <IconHome className="nav-item__icon" /> },
  { to: '/feed', label: 'Лента', icon: <IconFeed className="nav-item__icon" /> },
  { to: '/events', label: 'События', icon: <IconEvents className="nav-item__icon" /> },
  { to: '/moderation', label: 'Модерация', icon: <IconModeration className="nav-item__icon" />, badgeKey: 'moderation' },
  { to: '/published', label: 'Опубликованные', icon: <IconPublished className="nav-item__icon" /> },
  { to: '/analytics', label: 'Аналитика', icon: <IconAnalytics className="nav-item__icon" /> },
  { to: '/sources', label: 'Источники', icon: <IconSources className="nav-item__icon" /> },
  { to: '/map', label: 'Карта', icon: <IconMap className="nav-item__icon" /> },
  { to: '/settings', label: 'Настройки', icon: <IconSettings className="nav-item__icon" /> },
];

export function Sidebar({
  open,
  onNavigate,
  badges,
  status,
}: {
  open: boolean;
  onNavigate: () => void;
  badges: { moderation: number; errors: number };
  status: { healthy: boolean; degraded: boolean; updatedAt: string | null };
}) {
  const statusModifier = !status.healthy ? 'failing' : status.degraded ? 'degraded' : '';

  return (
    <aside className={`sidebar${open ? ' sidebar--open' : ''}`}>
      <div className="sidebar__brand">
        <div className="sidebar__logo">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
            <path
              d="M6 20.5c2.6-2.2 4.6-2.2 7.2 0s4.6 2.2 7.2 0 4.6-2.2 5.6-1.2"
              stroke="#60a5fa"
              strokeWidth="2.4"
              fill="none"
              strokeLinecap="round"
            />
            <path
              d="M6 13.5c2.6-2.2 4.6-2.2 7.2 0s4.6 2.2 7.2 0 4.6-2.2 5.6-1.2"
              stroke="#1d4ed8"
              strokeWidth="2.4"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="sidebar__brand-text">
          {/* Двухцветное начертание: «Novo» — город, «Today» — сегодняшний
              выпуск. Акцент только на второй половине, чтобы название
              читалось как одно слово, а не как две надписи. */}
          <div className="sidebar__title brand">
            Novo<span className="brand__accent">Today</span>
          </div>
          <div className="sidebar__subtitle">Новости Новороссийска</div>
        </div>
      </div>

      <nav className="sidebar__nav" aria-label="Основная навигация">
        {NAV.map((entry) => {
          const badge = entry.badgeKey ? badges[entry.badgeKey] : 0;
          return (
            <NavLink
              key={entry.to}
              to={entry.to}
              end={entry.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
            >
              {entry.icon}
              <span>{entry.label}</span>
              {badge > 0 && <span className="nav-item__badge">{badge > 99 ? '99+' : badge}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="system-status">
        <div className="system-status__row">
          <span className={`system-status__dot${statusModifier ? ` system-status__dot--${statusModifier}` : ''}`} />
          <span>
            {!status.healthy
              ? 'Есть неполадки'
              : status.degraded
                ? 'Работает с замечаниями'
                : 'Система работает'}
          </span>
        </div>
        <div className="system-status__meta">
          Последнее обновление
          <br />
          {status.updatedAt ? formatTime(status.updatedAt) : '—'}
        </div>
      </div>
    </aside>
  );
}
