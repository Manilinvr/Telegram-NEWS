import { useState } from 'react';
import type { EventDetail } from '@nnm/shared';
import {
  CONFIRMATION_LABELS,
  CONFIRMATION_TONE,
  formatConfidence,
  formatDateTime,
  formatRelative,
  IMPORTANCE_LABELS,
  IMPORTANCE_TONE,
  PROCESSING_STATUS_LABELS,
  sourceColor,
  sourceInitials,
} from '../../lib/format.js';
import { Alert, Badge, EmptyState } from '../ui/primitives.jsx';
import { IconBack, IconClose, IconLocation, IconPhoto, IconVideo } from '../ui/Icons.jsx';

/**
 * Карточка события (ТЗ §10).
 *
 * Показывает всё, что требует ТЗ, включая происхождение каждого факта и
 * оригинальные ссылки на источники: система не выдаёт переработанный
 * материал за собственный и всегда показывает, откуда взяты сведения.
 */
export function EventInspector({
  detail,
  onClose,
  onOpenRelated,
}: {
  detail: EventDetail;
  onClose: () => void;
  onOpenRelated?: (eventId: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'sources' | 'history'>('overview');

  const photos = detail.media.filter((item) => item.type === 'PHOTO');
  const videos = detail.media.filter((item) => item.type === 'VIDEO');

  return (
    <div className="inspector">
      <header className="inspector__header">
        <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Назад">
          <IconBack size={16} />
        </button>
        <span className="inspector__title">Просмотр новости</span>
        <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Закрыть">
          <IconClose size={16} />
        </button>
      </header>

      <div className="tabs">
        {(
          [
            ['overview', 'Обзор'],
            ['sources', `Источники (${detail.sources.length})`],
            ['history', 'Обработка'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`tab${tab === value ? ' tab--active' : ''}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="inspector__body">
        {tab === 'overview' && (
          <>
            <div className="detail-meta">
              {detail.category && <Badge color={detail.category.color}>{detail.category.title}</Badge>}
              <Badge tone={IMPORTANCE_TONE[detail.importance] as 'warning'}>
                {IMPORTANCE_LABELS[detail.importance]}
              </Badge>
              <Badge tone={CONFIRMATION_TONE[detail.confirmationStatus] as 'success'}>
                {CONFIRMATION_LABELS[detail.confirmationStatus]}
              </Badge>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {formatRelative(detail.occurredAt ?? detail.firstReportedAt)}
              </span>
            </div>

            <h3 className="detail-title">{detail.title}</h3>

            {detail.locationText && (
              <p
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-base)',
                  marginBottom: 'var(--space-4)',
                }}
              >
                <IconLocation size={14} />
                {detail.locationText}
              </p>
            )}

            {photos.length > 0 && (
              <div className="detail-section">
                <div className="detail-section__title">
                  <IconPhoto size={13} /> Фотографии ({photos.length})
                </div>
                <div className="media-grid">
                  {photos.map((item) => (
                    <a
                      key={item.id}
                      className="media-thumb"
                      href={item.url ?? '#'}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {item.url && <img src={item.thumbnailUrl ?? item.url} alt={item.caption ?? ''} loading="lazy" />}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {videos.length > 0 && (
              <div className="detail-section">
                <div className="detail-section__title">
                  <IconVideo size={13} /> Видео ({videos.length})
                  {videos.some((v) => v.hasTranscript) && <Badge tone="info">есть транскрипция</Badge>}
                </div>
                <div className="media-grid">
                  {videos.map((item) => (
                    <div key={item.id} className="media-thumb">
                      {item.thumbnailUrl && <img src={item.thumbnailUrl} alt="" loading="lazy" />}
                      <span className="media-thumb__badge">видео</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="detail-section">
              <div className="detail-section__title">Содержание</div>
              <p style={{ fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                {detail.summary || 'Описание не сформировано.'}
              </p>
            </div>

            {detail.facts.length > 0 && (
              <div className="detail-section">
                <div className="detail-section__title">Извлечённые факты</div>
                <div className="fact-list">
                  {detail.facts.map((fact) => (
                    <div
                      key={fact.id}
                      className={`fact${fact.isConfirmed ? ' fact--confirmed' : ''}${
                        fact.isAssumption ? ' fact--assumption' : ''
                      }`}
                    >
                      <span>
                        {fact.text}
                        {fact.attribution && (
                          <span className="fact__attribution">{fact.attribution}</span>
                        )}
                        {fact.isAssumption && (
                          <span className="fact__attribution">
                            Предположение, а не установленный факт
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.draft && detail.draft.uncertainties.length > 0 && (
              <div className="detail-section">
                <Alert tone="warning" title="Требует проверки">
                  <ul style={{ paddingLeft: 16, margin: 0 }}>
                    {detail.draft.uncertainties.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </Alert>
              </div>
            )}

            <div className="detail-section">
              <div className="detail-section__title">Информация</div>
              <div className="info-grid">
                <span className="info-grid__key">Категория</span>
                <span className="info-grid__value">{detail.category?.title ?? '—'}</span>
                <span className="info-grid__key">Приоритет</span>
                <span className="info-grid__value">{IMPORTANCE_LABELS[detail.importance]}</span>
                <span className="info-grid__key">Уверенность</span>
                <span className="info-grid__value">{formatConfidence(detail.confidence)}</span>
                <span className="info-grid__key">Статус</span>
                <span className="info-grid__value">{PROCESSING_STATUS_LABELS[detail.status]}</span>
                <span className="info-grid__key">Время события</span>
                <span className="info-grid__value">{formatDateTime(detail.occurredAt)}</span>
                <span className="info-grid__key">Первое сообщение</span>
                <span className="info-grid__value">{formatDateTime(detail.firstReportedAt)}</span>
                <span className="info-grid__key">Независимых источников</span>
                <span className="info-grid__value">{detail.independentSourceCount}</span>
                <span className="info-grid__key">Всего публикаций</span>
                <span className="info-grid__value">{detail.sourcePostCount}</span>
              </div>
            </div>

            {detail.relatedEvents.length > 0 && (
              <div className="detail-section">
                <div className="detail-section__title">Связанные события</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {detail.relatedEvents.map((related) => (
                    <button
                      key={related.id}
                      type="button"
                      className="source-chip"
                      onClick={() => onOpenRelated?.(related.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <Badge tone={related.relation === 'duplicate' ? 'warning' : 'muted'}>
                        {related.relation === 'duplicate' ? 'возможный дубль' : 'связано'}
                      </Badge>
                      <span className="source-chip__name">{related.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'sources' && (
          <>
            <div className="detail-section">
              <div className="detail-section__title">
                Источники события ({detail.sources.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detail.sources.map((source) => (
                  <div key={source.sourcePostId} className="source-chip">
                    <span
                      className="list-row__avatar"
                      style={{ background: sourceColor(source.sourceId), width: 22, height: 22 }}
                    >
                      {sourceInitials(source.sourceTitle)}
                    </span>
                    <span className="source-chip__name">{source.sourceTitle}</span>
                    {!source.isIndependent && <Badge tone="muted">перепечатка</Badge>}
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                      {formatRelative(source.postedAt)}
                    </span>
                    {source.originalUrl && (
                      <a href={source.originalUrl} target="_blank" rel="noreferrer noopener">
                        оригинал
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-section__title">Исходные публикации</div>
              {detail.posts.map((post) => (
                <details key={post.id} style={{ marginBottom: 'var(--space-2)' }}>
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontSize: 'var(--text-base)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {post.source.title} · {formatDateTime(post.postedAt)}
                    {post.rawHasProfanity && (
                      <>
                        {' '}
                        <Badge tone="danger">в источнике есть брань</Badge>
                      </>
                    )}
                  </summary>
                  <p
                    style={{
                      marginTop: 6,
                      padding: 'var(--space-3)',
                      background: 'var(--bg-panel-alt)',
                      borderRadius: 'var(--radius)',
                      fontSize: 'var(--text-base)',
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {post.rawText}
                  </p>
                </details>
              ))}
            </div>
          </>
        )}

        {tab === 'history' && (
          <div className="detail-section">
            <div className="detail-section__title">История обработки</div>
            {detail.processingHistory.length === 0 ? (
              <EmptyState title="Записей нет" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {detail.processingHistory.map((entry, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      gap: 'var(--space-3)',
                      padding: '6px var(--space-3)',
                      background: 'var(--bg-panel-alt)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    <span style={{ color: 'var(--text-muted)', minWidth: 96 }}>
                      {formatDateTime(entry.createdAt)}
                    </span>
                    <Badge
                      tone={
                        entry.status === 'OK' || entry.status === 'PASSED' || entry.status === 'APPROVED'
                          ? 'success'
                          : entry.status === 'BLOCKED' || entry.status === 'ERROR'
                            ? 'danger'
                            : 'muted'
                      }
                    >
                      {entry.stage}
                    </Badge>
                    <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{entry.message}</span>
                    {entry.durationMs !== null && (
                      <span style={{ color: 'var(--text-dim)' }}>{entry.durationMs} мс</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
