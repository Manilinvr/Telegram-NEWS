import { useMemo, useState } from 'react';
import { useCategories, useEventDetail, useFeed } from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { FeedCard } from '../components/feed/FeedCard.jsx';
import { EventInspector } from '../components/inspector/EventInspector.jsx';
import { Panel, QueryState } from '../components/ui/primitives.jsx';
import { IconTelegram } from '../components/ui/Icons.jsx';

/** Опубликованные материалы (ТЗ §14). */
export function PublishedPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const feed = useFeed({
    kind: 'events',
    isPublished: true,
    period: '30d',
    sort: 'newest',
    limit: 50,
  });
  const categories = useCategories();
  const detail = useEventDetail(selected);

  const categoryMap = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.slug, c])),
    [categories.data],
  );

  return (
    <>
      <PageHeader title="Опубликованные" subtitle="Материалы, отправленные в Telegram-канал" />

      <div className="workspace">
        <Panel title="История публикаций" flush>
          <QueryState
            isLoading={feed.isLoading}
            error={feed.error}
            isEmpty={(feed.data?.items.length ?? 0) === 0}
            emptyTitle="Публикаций пока нет"
            emptyHint="Одобренные материалы появятся здесь после отправки в канал."
          >
            <div className="feed">
              {feed.data?.items.map((item) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  category={categoryMap.get(item.categorySlug)}
                  onOpen={() => setSelected(item.id)}
                />
              ))}
            </div>
          </QueryState>
        </Panel>
      </div>

      {selected && detail.data && (
        <div
          className="overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <div className="inspector-row" style={{ gridTemplateColumns: 'minmax(0, 620px)' }}>
            <EventInspector detail={detail.data} onClose={() => setSelected(null)} />
          </div>
        </div>
      )}
    </>
  );
}
