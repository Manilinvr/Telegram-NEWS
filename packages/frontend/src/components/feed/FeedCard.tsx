import type { FeedItem } from '@nnm/shared';
import { Badge } from '../ui/primitives.jsx';
import {
  IconPhoto,
  IconSourceCount,
  IconTranscript,
  IconVideo,
  IconLocation,
  IconTelegram,
} from '../ui/Icons.jsx';
import { formatCount, formatTime, IMPORTANCE_LABELS, IMPORTANCE_TONE } from '../../lib/format.js';

/**
 * Карточка в ленте (ТЗ §16, §27).
 *
 * Показывает ровно то, что нужно для быстрого понимания: что, где, когда,
 * сколько источников подтверждают и есть ли медиа. Полный разбор
 * открывается по клику, не теряя позиции в ленте.
 */
export function FeedCard({
  item,
  category,
  onOpen,
  isNew,
}: {
  item: FeedItem;
  category?: { title: string; color: string } | undefined;
  onOpen: (item: FeedItem) => void;
  isNew?: boolean;
}) {
  return (
    <button
      type="button"
      className={`feed-card${isNew ? ' feed-card--new' : ''}`}
      onClick={() => onOpen(item)}
    >
      <div className="feed-card__body">
        <div className="feed-card__head">
          {category && <Badge color={category.color}>{category.title}</Badge>}
          {item.importance !== 'LOW' && (
            <Badge tone={IMPORTANCE_TONE[item.importance] as 'warning'}>
              {IMPORTANCE_LABELS[item.importance]}
            </Badge>
          )}
          {item.isPublished && (
            <Badge tone="success">
              <IconTelegram size={11} /> Опубликовано
            </Badge>
          )}
          <span className="feed-card__time">{formatTime(item.timestamp)}</span>
        </div>

        <h3 className="feed-card__title">{item.title}</h3>
        {item.excerpt && <p className="feed-card__excerpt">{item.excerpt}</p>}

        <div className="feed-card__footer">
          <span className="feed-card__chip">
            <IconSourceCount size={13} />
            {item.kind === 'event'
              ? formatCount(item.sourceCount, ['источник', 'источника', 'источников'])
              : item.sourceTitle}
          </span>

          {item.locationText && (
            <span className="feed-card__chip">
              <IconLocation size={13} />
              {item.locationText}
            </span>
          )}

          {item.hasPhoto && (
            <span className="feed-card__chip" title="Есть фотографии">
              <IconPhoto size={13} />
            </span>
          )}
          {item.hasVideo && (
            <span className="feed-card__chip" title="Есть видео">
              <IconVideo size={13} />
            </span>
          )}
          {item.hasTranscript && (
            <span className="feed-card__chip" title="Есть транскрипция">
              <IconTranscript size={13} />
            </span>
          )}
          {item.hasDraft && !item.isPublished && (
            <Badge tone="info">Черновик готов</Badge>
          )}
        </div>
      </div>

      {item.thumbnailUrl ? (
        <img
          className="feed-card__thumb"
          src={item.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : (
        item.hasPhoto && (
          <div className="feed-card__thumb feed-card__thumb--placeholder">
            <IconPhoto size={22} />
          </div>
        )
      )}
    </button>
  );
}
