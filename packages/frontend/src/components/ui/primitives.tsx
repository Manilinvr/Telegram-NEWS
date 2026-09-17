import type { ReactNode } from 'react';
import { formatCompact, formatDelta } from '../../lib/format.js';
import { IconError, IconWarning } from './Icons.jsx';

/** Базовые элементы интерфейса, используемые на всех экранах. */

export function Panel({
  title,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="panel__header">
          {title && <h2 className="panel__title">{title}</h2>}
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className={`panel__body${flush ? ' panel__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Badge({
  children,
  tone = 'muted',
  color,
}: {
  children: ReactNode;
  tone?: 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'outline' | 'category';
  /** Собственный цвет — используется для категорий из БД. */
  color?: string;
}) {
  if (color) {
    return (
      <span className="badge badge--category" style={{ background: color }}>
        {children}
      </span>
    );
  }
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function StatTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: number;
  delta?: number;
}) {
  const tone = delta === undefined || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down';
  return (
    <div className="stat-tile">
      <span className="stat-tile__label">{label}</span>
      <div className="stat-tile__value-row">
        <span className="stat-tile__value">{formatCompact(value)}</span>
        {delta !== undefined && (
          <span className={`stat-tile__delta stat-tile__delta--${tone}`}>{formatDelta(delta)}</span>
        )}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item${option.value === value ? ' segmented__item--active' : ''}`}
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state__icon">{icon}</div>}
      <p className="empty-state__title">{title}</p>
      {hint && <p className="empty-state__hint">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
      <span className="spinner" />
      {label && <span style={{ fontSize: 'var(--text-base)' }}>{label}</span>}
    </div>
  );
}

export function Alert({
  tone = 'default',
  title,
  children,
}: {
  tone?: 'default' | 'danger' | 'warning' | 'success';
  title?: string;
  children: ReactNode;
}) {
  const Icon = tone === 'danger' ? IconError : IconWarning;
  return (
    <div className={`alert${tone === 'default' ? '' : ` alert--${tone}`}`} role="alert">
      {tone !== 'default' && tone !== 'success' && (
        <Icon size={16} className="alert__icon" />
      )}
      <div>
        {title && <div className="alert__title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function SkeletonRows({ count = 4, height = 48 }: { count?: number; height?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 'var(--space-4)' }}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/** Индикатор загрузки/ошибки для панели. */
export function QueryState({
  isLoading,
  error,
  isEmpty,
  emptyTitle,
  emptyHint,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  children: ReactNode;
}) {
  if (isLoading) return <SkeletonRows />;

  if (error) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <Alert tone="danger" title="Не удалось загрузить данные">
          {(error as Error).message}
        </Alert>
      </div>
    );
  }

  if (isEmpty) {
    return <EmptyState title={emptyTitle ?? 'Нет данных'} hint={emptyHint} />;
  }

  return <>{children}</>;
}
