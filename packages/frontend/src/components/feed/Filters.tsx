import type { FeedFilterInput } from '@nnm/shared';
import { IMPORTANCE_LABELS } from '../../lib/format.js';
import { IconCheck, IconSearch } from '../ui/Icons.jsx';

/**
 * Панель фильтров (ТЗ §6).
 *
 * Все фильтры комбинируются и применяются сразу: мониторинг — это работа
 * с потоком, и отдельная кнопка «Применить» здесь только мешала бы.
 */

export interface FilterState {
  period: '1h' | '24h' | '7d' | '30d' | 'all';
  categories: string[];
  importance: string[];
  sources: string[];
  kind: 'all' | 'events' | 'posts';
  hasPhoto?: boolean;
  hasVideo?: boolean;
  hasTranscript?: boolean;
  hasDraft?: boolean;
  isPublished?: boolean;
  q: string;
  sort: 'newest' | 'oldest' | 'importance' | 'confidence' | 'sources';
}

export const DEFAULT_FILTERS: FilterState = {
  period: '24h',
  categories: [],
  importance: [],
  sources: [],
  kind: 'all',
  q: '',
  sort: 'newest',
};

/** Преобразовать состояние панели в параметры запроса к API. */
export function toQuery(state: FilterState, limit = 50, offset = 0): FeedFilterInput {
  return {
    period: state.period,
    kind: state.kind,
    sort: state.sort,
    limit,
    offset,
    ...(state.categories.length ? { categories: state.categories } : {}),
    ...(state.importance.length ? { importance: state.importance as never } : {}),
    ...(state.sources.length ? { sources: state.sources } : {}),
    ...(state.hasPhoto !== undefined ? { hasPhoto: state.hasPhoto } : {}),
    ...(state.hasVideo !== undefined ? { hasVideo: state.hasVideo } : {}),
    ...(state.hasTranscript !== undefined ? { hasTranscript: state.hasTranscript } : {}),
    ...(state.hasDraft !== undefined ? { hasDraft: state.hasDraft } : {}),
    ...(state.isPublished !== undefined ? { isPublished: state.isPublished } : {}),
    ...(state.q.trim() ? { q: state.q.trim() } : {}),
  };
}

function FilterRow({
  checked,
  onToggle,
  label,
  color,
  count,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  color?: string;
  count?: number;
}) {
  return (
    <button type="button" className="filter-row" onClick={onToggle} aria-pressed={checked}>
      <span className={`filter-row__checkbox${checked ? ' filter-row__checkbox--checked' : ''}`}>
        {checked && <IconCheck size={11} strokeWidth={3} />}
      </span>
      {color && <span className="filter-row__swatch" style={{ background: color }} />}
      <span className="filter-row__label">{label}</span>
      {count !== undefined && <span className="filter-row__count">{count}</span>}
    </button>
  );
}

export function Filters({
  state,
  onChange,
  categories,
  sources,
  counts,
}: {
  state: FilterState;
  onChange: (next: FilterState) => void;
  categories: Array<{ slug: string; title: string; color: string }>;
  sources: Array<{ id: string; title: string; type: string }>;
  counts?: { total: number };
}) {
  const toggle = <K extends 'categories' | 'importance' | 'sources'>(key: K, value: string) => {
    const current = state[key];
    onChange({
      ...state,
      [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    });
  };

  const toggleFlag = (key: 'hasPhoto' | 'hasVideo' | 'hasTranscript' | 'hasDraft' | 'isPublished') => {
    // Три состояния: не задан → только с признаком → только без признака.
    const current = state[key];
    const next = current === undefined ? true : current === true ? false : undefined;
    onChange({ ...state, [key]: next });
  };

  const hasActiveFilters =
    state.categories.length > 0 ||
    state.importance.length > 0 ||
    state.sources.length > 0 ||
    state.q !== '' ||
    state.kind !== 'all' ||
    [state.hasPhoto, state.hasVideo, state.hasTranscript, state.hasDraft, state.isPublished].some(
      (v) => v !== undefined,
    );

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">Фильтры</h2>
        {hasActiveFilters && (
          <div className="panel__actions">
            <button type="button" className="panel__link" onClick={() => onChange(DEFAULT_FILTERS)}>
              Сбросить
            </button>
          </div>
        )}
      </header>

      <div className="panel__body">
        <div style={{ position: 'relative', marginBottom: 'var(--space-3)' }}>
          <IconSearch
            size={14}
            style={{
              position: 'absolute',
              left: 9,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-dim)',
              pointerEvents: 'none',
            }}
          />
          <input
            className="input"
            style={{ paddingLeft: 30 }}
            type="search"
            placeholder="Поиск по тексту…"
            value={state.q}
            onChange={(event) => onChange({ ...state, q: event.target.value })}
            aria-label="Поиск по заголовку, тексту, фактам и транскрипции"
          />
        </div>

        <div className="filter-group">
          <div className="filter-group__title">Показывать</div>
          {(
            [
              ['all', 'Всё'],
              ['events', 'Только события'],
              ['posts', 'Только публикации'],
            ] as const
          ).map(([value, label]) => (
            <FilterRow
              key={value}
              checked={state.kind === value}
              onToggle={() => onChange({ ...state, kind: value })}
              label={label}
              {...(value === 'all' && counts ? { count: counts.total } : {})}
            />
          ))}
        </div>

        <div className="filter-group">
          <div className="filter-group__title">Период</div>
          {(
            [
              ['1h', 'Последний час'],
              ['24h', 'Сутки'],
              ['7d', 'Неделя'],
              ['30d', 'Месяц'],
              ['all', 'Всё время'],
            ] as const
          ).map(([value, label]) => (
            <FilterRow
              key={value}
              checked={state.period === value}
              onToggle={() => onChange({ ...state, period: value })}
              label={label}
            />
          ))}
        </div>

        <div className="filter-group">
          <div className="filter-group__title">Категории</div>
          {categories.map((category) => (
            <FilterRow
              key={category.slug}
              checked={state.categories.includes(category.slug)}
              onToggle={() => toggle('categories', category.slug)}
              label={category.title}
              color={category.color}
            />
          ))}
        </div>

        <div className="filter-group">
          <div className="filter-group__title">Приоритет</div>
          {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((level) => (
            <FilterRow
              key={level}
              checked={state.importance.includes(level)}
              onToggle={() => toggle('importance', level)}
              label={IMPORTANCE_LABELS[level]}
            />
          ))}
        </div>

        {sources.length > 0 && (
          <div className="filter-group">
            <div className="filter-group__title">Источники</div>
            {sources.slice(0, 12).map((source) => (
              <FilterRow
                key={source.id}
                checked={state.sources.includes(source.id)}
                onToggle={() => toggle('sources', source.id)}
                label={source.title}
              />
            ))}
          </div>
        )}

        <div className="filter-group">
          <div className="filter-group__title">Содержимое</div>
          {(
            [
              ['hasPhoto', 'Есть фото'],
              ['hasVideo', 'Есть видео'],
              ['hasTranscript', 'Есть транскрипция'],
              ['hasDraft', 'Есть черновик'],
              ['isPublished', 'Опубликовано'],
            ] as const
          ).map(([key, label]) => {
            const value = state[key];
            return (
              <button
                key={key}
                type="button"
                className="filter-row"
                onClick={() => toggleFlag(key)}
                aria-pressed={value !== undefined}
              >
                <span
                  className={`filter-row__checkbox${value !== undefined ? ' filter-row__checkbox--checked' : ''}`}
                  style={value === false ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
                >
                  {value === true && <IconCheck size={11} strokeWidth={3} />}
                  {value === false && <span style={{ fontSize: 12, lineHeight: 1 }}>−</span>}
                </span>
                <span className="filter-row__label">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
