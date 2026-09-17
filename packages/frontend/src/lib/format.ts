import type { ConfirmationStatus, Importance, ModerationStatus, ProcessingStatus } from '@nnm/shared';

/** Форматирование данных для интерфейса. Город живёт по московскому времени. */

const TIME_ZONE = 'Europe/Moscow';

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TIME_ZONE,
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  });
}

/**
 * Относительное время: «только что», «12 мин назад».
 * В ленте мониторинга важнее давность, чем точная отметка.
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return formatTime(iso);
  if (seconds < 45) return 'только что';
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин назад`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} ч назад`;
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)} дн назад`;
  return formatDate(iso);
}

/** Правильная форма существительного при числе. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatCount(count: number, forms: [string, string, string]): string {
  return `${count} ${plural(count, forms[0], forms[1], forms[2])}`;
}

/** Компактная запись больших чисел: 1234 → 1,2К. */
export function formatCompact(value: number): string {
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1).replace('.0', '')}К`;
  return `${(value / 1_000_000).toFixed(1).replace('.0', '')}М`;
}

export function formatDelta(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : String(value);
}

export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// --- Человекочитаемые названия статусов ------------------------------------

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  LOW: 'Низкий',
  MEDIUM: 'Средний',
  HIGH: 'Высокий',
  CRITICAL: 'Критический',
};

export const IMPORTANCE_TONE: Record<Importance, string> = {
  LOW: 'muted',
  MEDIUM: 'info',
  HIGH: 'warning',
  CRITICAL: 'danger',
};

export const PROCESSING_STATUS_LABELS: Record<ProcessingStatus, string> = {
  NEW: 'Новая',
  PROCESSING: 'Обработка',
  PROCESSED: 'Обработана',
  NEEDS_REVIEW: 'Нужна проверка',
  APPROVED: 'Одобрена',
  PUBLISHED: 'Опубликована',
  REJECTED: 'Отклонена',
  ERROR: 'Ошибка',
};

export const MODERATION_STATUS_LABELS: Record<ModerationStatus, string> = {
  PENDING: 'Ожидает',
  IN_REVIEW: 'На проверке',
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
  PUBLISHED: 'Опубликовано',
  BLOCKED: 'Заблокировано',
};

export const CONFIRMATION_LABELS: Record<ConfirmationStatus, string> = {
  UNCONFIRMED: 'Не подтверждено',
  PARTIALLY_CONFIRMED: 'Частично подтверждено',
  CONFIRMED: 'Подтверждено',
};

export const CONFIRMATION_TONE: Record<ConfirmationStatus, string> = {
  UNCONFIRMED: 'muted',
  PARTIALLY_CONFIRMED: 'warning',
  CONFIRMED: 'success',
};

export const SOURCE_HEALTH_LABELS: Record<string, string> = {
  HEALTHY: 'Работает',
  DEGRADED: 'Сбои',
  FAILING: 'Не отвечает',
  DISABLED: 'Отключён',
  UNKNOWN: 'Не проверялся',
};

/** Инициалы источника для аватара в списке. */
export function sourceInitials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  if (words.length === 0) return '??';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0] ?? ''}${(words[1] as string)[0] ?? ''}`.toUpperCase();
}

/** Устойчивый цвет источника — одинаковый при каждой отрисовке. */
export function sourceColor(id: string): string {
  const palette = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#22d3ee', '#6366f1'];
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] as string;
}
