import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from '@nnm/shared';
import { formatTime } from '../../lib/format.js';

/**
 * Предпросмотр Telegram-поста (ТЗ §12).
 *
 * Оформление повторяет вид сообщения в канале, а текст выводится с
 * сохранением переносов и пробелов (`white-space: pre-wrap`), потому что
 * пользователь должен видеть результат максимально близким к реальному —
 * включая пустые строки, эмодзи и порядок медиа.
 */
export function TelegramPreview({
  text,
  media = [],
  channel,
}: {
  text: string;
  media?: Array<{ url: string | null; type: string }>;
  channel?: string | null;
}) {
  const images = media.filter((item) => item.url && item.type === 'PHOTO').slice(0, 3);
  const limit = images.length > 0 ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;
  const isOver = text.length > limit;

  return (
    <div>
      <div className="tg-preview">
        <div className="tg-preview__bubble">
          {images.length > 0 && (
            <div className={`tg-preview__media tg-preview__media--${Math.min(images.length, 3)}`}>
              {images.map((item, index) => (
                <img key={index} src={item.url as string} alt="" loading="lazy" />
              ))}
            </div>
          )}
          <div className="tg-preview__text">{text || 'Текст поста пуст'}</div>
          <div className="tg-preview__footer">
            <span>{formatTime(new Date().toISOString())}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7f92" strokeWidth="2.4" aria-hidden="true">
              <path d="m3 13 4 4L17 7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="m11 15 2 2L23 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <div className={`tg-preview__counter${isOver ? ' tg-preview__counter--over' : ''}`}>
        <span>
          {channel ? `Канал: ${channel}` : 'Канал не настроен'}
          {images.length > 0 ? ` · вложений: ${images.length}` : ''}
        </span>
        <span>
          {text.length} / {limit}
          {isOver ? ' — превышен лимит' : ''}
        </span>
      </div>
    </div>
  );
}
