import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FeedItem } from '@nnm/shared';
import {
  useCategories,
  useDashboard,
  useEventDetail,
  useFeed,
  useMapMarkers,
  useSources,
} from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { LineChart } from '../components/charts/LineChart.jsx';
import { DonutChart } from '../components/charts/DonutChart.jsx';
import { EventMap } from '../components/map/EventMap.jsx';
import { FeedCard } from '../components/feed/FeedCard.jsx';
import { DEFAULT_FILTERS, Filters, toQuery, type FilterState } from '../components/feed/Filters.jsx';
import { EventInspector } from '../components/inspector/EventInspector.jsx';
import { DraftEditor } from '../components/inspector/DraftEditor.jsx';
import { VideoTranscript } from '../components/inspector/VideoTranscript.jsx';
import { Badge, EmptyState, Panel, QueryState, Segmented } from '../components/ui/primitives.jsx';
import {
  formatRelative,
  formatTime,
  sourceColor,
  sourceInitials,
  SOURCE_HEALTH_LABELS,
} from '../lib/format.js';
import { IconFeed, IconTelegram } from '../components/ui/Icons.jsx';

/**
 * Главный экран — центр управления новостями (ТЗ §14).
 *
 * Композиция повторяет логику работы: сверху показатели и динамика, ниже —
 * фильтры, живая лента и правая колонка с картой и очередью модерации.
 * Карточка события открывается поверх, не убирая ленту из-под себя, чтобы
 * не терялся контекст (ТЗ §27).
 */
export function DashboardPage() {
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('24h');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const navigate = useNavigate();
  const dashboard = useDashboard(period);
  const categories = useCategories();
  const sources = useSources();
  const markers = useMapMarkers(period === '24h' ? 24 : period === '7d' ? 168 : 720);
  const feed = useFeed(toQuery(filters, 25));
  const detail = useEventDetail(selectedEvent);

  const categoryMap = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.slug, c])),
    [categories.data],
  );

  const handleOpen = (item: FeedItem) => {
    // Публикация без события открывается через своё событие, если оно есть.
    setSelectedEvent(item.kind === 'event' ? item.id : item.eventId);
  };

  const summary = dashboard.data?.summary;

  return (
    <>
      <PageHeader
        title="Новороссийск"
        subtitle="Мониторинг новостей и событий города в реальном времени"
        {...(summary ? { summary } : {})}
      />

      <div className="workspace">
        {/* --- Верхний ряд: динамика, категории, источники, события --- */}
        <div className="grid grid--dashboard-top" style={{ marginBottom: 'var(--space-4)' }}>
          <Panel
            title="Динамика публикаций"
            actions={
              <Segmented
                value={period}
                onChange={setPeriod}
                options={[
                  { value: '24h', label: '24ч' },
                  { value: '7d', label: '7д' },
                  { value: '30d', label: '30д' },
                ]}
              />
            }
          >
            <QueryState isLoading={dashboard.isLoading} error={dashboard.error}>
              <LineChart points={dashboard.data?.timeseries ?? []} />
            </QueryState>
          </Panel>

          <Panel title="Категории новостей">
            <QueryState isLoading={dashboard.isLoading} error={dashboard.error}>
              <DonutChart
                items={dashboard.data?.categories ?? []}
                onSelect={(slug) =>
                  setFilters((state) => ({
                    ...state,
                    categories: state.categories.includes(slug) ? [] : [slug],
                  }))
                }
              />
            </QueryState>
          </Panel>

          <Panel title="Топ источников" flush>
            <QueryState
              isLoading={dashboard.isLoading}
              error={dashboard.error}
              isEmpty={(dashboard.data?.topSources.length ?? 0) === 0}
              emptyTitle="Источники не добавлены"
              emptyHint="Добавьте Telegram-каналы и сообщества VK в разделе «Источники»."
            >
              <div className="list" style={{ paddingBottom: 'var(--space-3)' }}>
                {dashboard.data?.topSources.map((source) => (
                  <button
                    key={source.sourceId}
                    type="button"
                    className="list-row"
                    onClick={() => navigate('/sources')}
                  >
                    <span
                      className="list-row__avatar"
                      style={{ background: sourceColor(source.sourceId) }}
                    >
                      {sourceInitials(source.title)}
                    </span>
                    <span className="list-row__body">
                      <span className="list-row__title">{source.title}</span>
                      <span className="list-row__meta">
                        {source.type === 'TELEGRAM' ? 'Telegram' : 'VK'} ·{' '}
                        {SOURCE_HEALTH_LABELS[source.health] ?? source.health}
                      </span>
                    </span>
                    <span className="list-row__value">{source.postCount}</span>
                  </button>
                ))}
              </div>
            </QueryState>
          </Panel>

          <Panel
            title="Последние события"
            actions={
              <button type="button" className="panel__link" onClick={() => navigate('/events')}>
                Смотреть все
              </button>
            }
            flush
          >
            <QueryState
              isLoading={dashboard.isLoading}
              error={dashboard.error}
              isEmpty={(dashboard.data?.recentEvents.length ?? 0) === 0}
              emptyTitle="Событий пока нет"
            >
              <div className="list" style={{ paddingBottom: 'var(--space-3)' }}>
                {dashboard.data?.recentEvents.map((event) => {
                  const category = categoryMap.get(event.categorySlug);
                  return (
                    <button
                      key={event.id}
                      type="button"
                      className="list-row"
                      onClick={() => setSelectedEvent(event.id)}
                    >
                      <span
                        className="list-row__avatar"
                        style={{ background: category?.color ?? 'var(--cat-other)' }}
                      >
                        {category?.emoji ?? '📰'}
                      </span>
                      <span className="list-row__body">
                        <span className="list-row__title">{event.title}</span>
                        <span className="list-row__meta">{category?.title ?? 'Другое'}</span>
                      </span>
                      <span className="list-row__time">{formatTime(event.timestamp)}</span>
                    </button>
                  );
                })}
              </div>
            </QueryState>
          </Panel>
        </div>

        {/* --- Основной ряд: фильтры, лента, карта и очередь --- */}
        <div className="grid grid--dashboard-main">
          <Filters
            state={filters}
            onChange={setFilters}
            categories={categories.data ?? []}
            sources={(sources.data?.sources ?? []).map((s) => ({
              id: s.id,
              title: s.title,
              type: s.type,
            }))}
            {...(feed.data ? { counts: { total: feed.data.total } } : {})}
          />

          <Panel
            title="Лента новостей"
            actions={
              <Segmented
                value={filters.kind}
                onChange={(kind) => setFilters((state) => ({ ...state, kind }))}
                options={[
                  { value: 'all', label: 'Все' },
                  { value: 'events', label: 'События' },
                  { value: 'posts', label: 'Посты' },
                ]}
              />
            }
            flush
          >
            <QueryState
              isLoading={feed.isLoading}
              error={feed.error}
              isEmpty={(feed.data?.items.length ?? 0) === 0}
              emptyTitle="По заданным фильтрам ничего не найдено"
              emptyHint="Измените период или снимите часть фильтров."
            >
              <div className="feed feed--boxed">
                {feed.data?.items.map((item) => (
                  <FeedCard
                    key={`${item.kind}-${item.id}`}
                    item={item}
                    category={categoryMap.get(item.categorySlug)}
                    onOpen={handleOpen}
                  />
                ))}
              </div>
            </QueryState>
          </Panel>

          <div className="stack">
            <Panel title="Карта событий" flush>
              <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
                <EventMap markers={markers.data ?? []} onSelect={setSelectedEvent} />
              </div>
            </Panel>

            <Panel
              title="Очередь на проверку"
              actions={
                <button type="button" className="panel__link" onClick={() => navigate('/moderation')}>
                  Смотреть все
                </button>
              }
              flush
            >
              <QueryState
                isLoading={dashboard.isLoading}
                error={dashboard.error}
                isEmpty={(dashboard.data?.moderationQueue.length ?? 0) === 0}
                emptyTitle="Очередь пуста"
                emptyHint="Все материалы рассмотрены."
              >
                <div className="list" style={{ paddingBottom: 'var(--space-3)' }}>
                  {dashboard.data?.moderationQueue.map((item) => {
                    const category = categoryMap.get(item.categorySlug);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="list-row"
                        onClick={() => setSelectedEvent(item.eventId)}
                      >
                        <span className="list-row__time">{formatTime(item.createdAt)}</span>
                        <span
                          className="list-row__avatar"
                          style={{ background: category?.color ?? 'var(--cat-other)', width: 20, height: 20 }}
                        >
                          {category?.emoji ?? '📰'}
                        </span>
                        <span className="list-row__body">
                          <span className="list-row__title">{item.title}</span>
                          {item.blockedReason && (
                            <span className="list-row__meta" style={{ color: 'var(--danger)' }}>
                              заблокировано проверкой
                            </span>
                          )}
                        </span>
                        {item.status === 'BLOCKED' && <Badge tone="danger">блок</Badge>}
                      </button>
                    );
                  })}
                </div>
              </QueryState>
            </Panel>
          </div>
        </div>
      </div>

      {/* --- Инспектор поверх ленты --- */}
      {selectedEvent && detail.data && (
        <div
          className="overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedEvent(null);
          }}
        >
          <div className="inspector-row">
            <EventInspector
              detail={detail.data}
              onClose={() => setSelectedEvent(null)}
              onOpenRelated={setSelectedEvent}
            />
            <DraftEditor detail={detail.data} onClose={() => setSelectedEvent(null)} />
            <div className="inspector">
              <header className="inspector__header">
                <span className="inspector__title">Видео и транскрипция</span>
              </header>
              <div className="inspector__body">
                <VideoTranscript media={detail.data.media} transcripts={detail.data.transcripts} />
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedEvent && detail.isLoading && (
        <div className="overlay">
          <div className="inspector-row">
            <div className="inspector">
              <div className="inspector__body">
                <EmptyState icon={<IconFeed size={26} />} title="Загрузка карточки…" />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
