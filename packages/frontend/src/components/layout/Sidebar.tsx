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
import { formatCount, formatTime } from '../../lib/format.js';

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
  /**
   * Состояние системы двумя разными величинами, а не одним флагом.
   *
   * Различие существенное: остановившийся сбор и записи в журнале ошибок —
   * разные вещи. Раньше любая запись, в том числе от давно исправленной
   * причины, красила индикатор красным наравне с отвалившимся источником,
   * и он переставал что-либо значить.
   */
  status: {
    failingSources: number;
    unresolvedErrors: number;
    updatedAt: string | null;
  };
}) {
  const { failingSources, unresolvedErrors } = status;

  // Красный — сбор реально встал. Жёлтый — работает, но есть на что
  // посмотреть. Источник перестаёт опрашиваться после пяти неудач подряд,
  // так что красный не зажигается от одиночного сбоя сети.
  const statusModifier = failingSources > 0 ? 'failing' : unresolvedErrors > 0 ? 'degraded' : '';

  const statusLabel =
    failingSources > 0
      ? 'Сбор остановлен'
      : unresolvedErrors > 0
        ? 'Работает с замечаниями'
        : 'Система работает';

  // Подсказка называет причину числом: «97 неразобранных ошибок» говорит
  // больше, чем «есть неполадки».
  const reasons: string[] = [];
  if (failingSources > 0) {
    reasons.push(
      `${formatCount(failingSources, ['источник не отвечает', 'источника не отвечают', 'источников не отвечают'])}`,
    );
  }
  if (unresolvedErrors > 0) {
    reasons.push(
      `${formatCount(unresolvedErrors, ['неразобранная ошибка', 'неразобранные ошибки', 'неразобранных ошибок'])}`,
    );
  }
  const statusHint = reasons.length > 0 ? reasons.join(', ') : 'Сбор и обработка идут без сбоев';

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

      <div className="system-status" title={statusHint}>
        <div className="system-status__row">
          <span className={`system-status__dot${statusModifier ? ` system-status__dot--${statusModifier}` : ''}`} />
          <span>{statusLabel}</span>
        </div>
        <div className="system-status__meta">
          {reasons.length > 0 && (
            <>
              {statusHint}
              <br />
            </>
          )}
          Последнее обновление
          <br />
          {status.updatedAt ? formatTime(status.updatedAt) : '—'}
        </div>
      </div>
    </aside>
  );
}
