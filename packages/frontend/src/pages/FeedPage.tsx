import { useMemo, useState } from 'react';
import type { FeedItem } from '@nnm/shared';
import { useCategories, useEventDetail, useFeed, useSources } from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { FeedCard } from '../components/feed/FeedCard.jsx';
import { DEFAULT_FILTERS, Filters, toQuery, type FilterState } from '../components/feed/Filters.jsx';
import { EventInspector } from '../components/inspector/EventInspector.jsx';
import { DraftEditor } from '../components/inspector/DraftEditor.jsx';
import { VideoTranscript } from '../components/inspector/VideoTranscript.jsx';
import { Panel, QueryState, Segmented } from '../components/ui/primitives.jsx';
import { formatCount } from '../lib/format.js';

/** Лента с полным набором фильтров (ТЗ §6, §16). */
export function FeedPage({ eventsOnly = false }: { eventsOnly?: boolean }) {
  const [filters, setFilters] = useState<FilterState>({
    ...DEFAULT_FILTERS,
    kind: eventsOnly ? 'events' : 'all',
  });
  const [page, setPage] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const pageSize = 50;
  const feed = useFeed(toQuery(filters, pageSize, page * pageSize));
  const categories = useCategories();
  const sources = useSources();
  const detail = useEventDetail(selectedEvent);

  const categoryMap = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.slug, c])),
    [categories.data],
  );

  const handleFilterChange = (next: FilterState) => {
    setFilters(next);
    // Смена фильтра всегда возвращает к первой странице: иначе можно
    // оказаться на пустой странице несуществующей выборки.
    setPage(0);
  };

  const handleOpen = (item: FeedItem) => {
    setSelectedEvent(item.kind === 'event' ? item.id : item.eventId);
  };

  const total = feed.data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <>
      <PageHeader
        title={eventsOnly ? 'События' : 'Лента'}
        subtitle={
          total > 0
            ? `Найдено ${formatCount(total, ['материал', 'материала', 'материалов'])}`
            : 'Публикации и события из подключённых источников'
        }
      />

      <div className="workspace">
        <div className="grid" style={{ gridTemplateColumns: '236px minmax(0, 1fr)', alignItems: 'start' }}>
          <Filters
            state={filters}
            onChange={handleFilterChange}
            categories={categories.data ?? []}
            sources={(sources.data?.sources ?? []).map((s) => ({
              id: s.id,
              title: s.title,
              type: s.type,
            }))}
            counts={{ total }}
          />

          <Panel
            title="Материалы"
            actions={
              <Segmented
                value={filters.sort}
                onChange={(sort) => handleFilterChange({ ...filters, sort })}
                options={[
                  { value: 'newest', label: 'Новые' },
                  { value: 'importance', label: 'Важные' },
                  { value: 'sources', label: 'Источники' },
                ]}
              />
            }
            flush
          >
            <QueryState
              isLoading={feed.isLoading}
              error={feed.error}
              isEmpty={(feed.data?.items.length ?? 0) === 0}
              emptyTitle="Ничего не найдено"
              emptyHint="Измените фильтры или расширьте период."
            >
              <div className="feed">
                {feed.data?.items.map((item) => (
                  <FeedCard
                    key={`${item.kind}-${item.id}`}
                    item={item}
                    category={categoryMap.get(item.categorySlug)}
                    onOpen={handleOpen}
                  />
                ))}
              </div>

              {maxPage > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-4)',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Назад
                  </button>
                  <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                    Страница {page + 1} из {maxPage + 1}
                  </span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={page >= maxPage}
                    onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                  >
                    Вперёд
                  </button>
                </div>
              )}
            </QueryState>
          </Panel>
        </div>
      </div>

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
    </>
  );
}
