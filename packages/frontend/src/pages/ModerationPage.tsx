import { useMemo, useState } from 'react';
import { useCategories, useEventDetail, useModerationQueue } from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { EventInspector } from '../components/inspector/EventInspector.jsx';
import { DraftEditor } from '../components/inspector/DraftEditor.jsx';
import { VideoTranscript } from '../components/inspector/VideoTranscript.jsx';
import { Badge, Panel, QueryState, Segmented } from '../components/ui/primitives.jsx';
import { formatRelative, IMPORTANCE_LABELS, IMPORTANCE_TONE, MODERATION_STATUS_LABELS } from '../lib/format.js';

/**
 * Очередь модерации (ТЗ §13).
 *
 * Материалы упорядочены по приоритету и времени: критические попадают
 * наверх, чтобы не потеряться в потоке.
 */
export function ModerationPage() {
  const [statusFilter, setStatusFilter] = useState<'pending' | 'blocked' | 'rejected' | 'all'>('pending');
  // Сортировка выполняется на месте: очередь целиком уже загружена, и
  // лишний запрос к серверу ради перестановки строк не нужен.
  const [sortBy, setSortBy] = useState<'priority' | 'time' | 'title'>('priority');
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);

  const statuses =
    statusFilter === 'pending'
      ? ['PENDING', 'IN_REVIEW']
      : statusFilter === 'blocked'
        ? ['BLOCKED']
        : // Отклонённые не пропадают: их видно отдельной вкладкой, откуда
          // материал можно открыть, поправить и вернуть в работу.
          statusFilter === 'rejected'
          ? ['REJECTED']
          : undefined;

  const queue = useModerationQueue(statuses);
  const categories = useCategories();
  const detail = useEventDetail(selectedEvent);

  const categoryMap = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.slug, c])),
    [categories.data],
  );

  const counts = queue.data?.counts;

  const PRIORITY_ORDER: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };

  const items = useMemo(() => {
    const list = [...(queue.data?.items ?? [])];
    if (sortBy === 'time') {
      // Новые сверху: свежая новость важнее вчерашней.
      return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    if (sortBy === 'title') {
      return list.sort((a, b) =>
        (a.eventTitle ?? '').localeCompare(b.eventTitle ?? '', 'ru', { sensitivity: 'base' }),
      );
    }
    // По срочности, а внутри одной срочности — новые сверху.
    return list.sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  }, [queue.data?.items, sortBy]);

  return (
    <>
      <PageHeader
        title="Модерация"
        subtitle={
          counts
            ? `Ожидают проверки: ${counts.pending} · заблокировано: ${counts.blocked}`
            : 'Ручная проверка материалов перед публикацией'
        }
      />

      <div className="workspace">
        <Panel
          title="Очередь материалов"
          actions={
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Segmented
              value={sortBy}
              onChange={setSortBy}
              options={[
                { value: 'priority', label: 'По срочности' },
                { value: 'time', label: 'По времени' },
                { value: 'title', label: 'По событию' },
              ]}
            />
            <Segmented
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'pending', label: 'Ожидают' },
                { value: 'blocked', label: 'Заблокированы' },
                { value: 'rejected', label: 'Отклонённые' },
                { value: 'all', label: 'Все' },
              ]}
            />
            </div>
          }
          flush
        >
          <QueryState
            isLoading={queue.isLoading}
            error={queue.error}
            isEmpty={items.length === 0}
            emptyTitle="Очередь пуста"
            emptyHint="Новые материалы появятся здесь автоматически после обработки."
          >
            <div className="list list--boxed" style={{ padding: 'var(--space-2) 0' }}>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="list-row"
                  onClick={() => setSelectedEvent(item.eventId)}
                >
                  <Badge tone={IMPORTANCE_TONE[item.priority] as 'warning'}>
                    {IMPORTANCE_LABELS[item.priority]}
                  </Badge>
                  <span className="list-row__body">
                    <span className="list-row__title">
                      {item.eventTitle || `Событие ${item.eventId.slice(0, 8)}`}
                    </span>
                    <span className="list-row__meta">
                      {[
                        item.categoryTitle,
                        item.sourceTitles?.length ? item.sourceTitles.join(', ') : null,
                        item.blockedReason
                          ? `Заблокировано: ${item.blockedReason}`
                          : item.rejectionReason
                            ? `Отклонено: ${item.rejectionReason}`
                            : formatRelative(item.createdAt),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Badge
                    tone={
                      item.status === 'BLOCKED'
                        ? 'danger'
                        : item.status === 'APPROVED'
                          ? 'success'
                          : 'muted'
                    }
                  >
                    {MODERATION_STATUS_LABELS[item.status]}
                  </Badge>
                </button>
              ))}
            </div>
          </QueryState>
        </Panel>
      </div>

      {selectedEvent && detail.data && (
        <div
          className="overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedEvent(null);
          }}
        >
          <div className="inspector-row">
            <EventInspector detail={detail.data} onClose={() => setSelectedEvent(null)} />
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
