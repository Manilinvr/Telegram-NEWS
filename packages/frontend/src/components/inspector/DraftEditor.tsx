import { useEffect, useState } from 'react';
import type { EventDetail, ProfanityReport } from '@nnm/shared';
import {
  useApprove,
  usePreview,
  usePublish,
  useRegenerateDraft,
  useReject,
  useRestore,
  useSaveDraft,
} from '../../api/hooks.js';
import { ApiError } from '../../api/client.js';
import { Alert, Badge } from '../ui/primitives.jsx';
import {
  IconCheck,
  IconClose,
  IconEye,
  IconRefresh,
  IconSave,
  IconTelegram,
} from '../ui/Icons.jsx';
import { TelegramPreview } from './TelegramPreview.jsx';
import { IMPORTANCE_LABELS, MODERATION_STATUS_LABELS } from '../../lib/format.js';

/**
 * Редактирование и публикация (ТЗ §11, §12, §13).
 *
 * Порядок действий соответствует ТЗ: правка → проверка → одобрение →
 * публикация. Каждый шаг проверяется на сервере, поэтому интерфейс не
 * пытается «предугадать» результат: он показывает ровно то, что ответил
 * backend, включая причину блокировки.
 */
export function DraftEditor({
  detail,
  onClose,
  channel,
}: {
  detail: EventDetail;
  onClose: () => void;
  channel?: string | null;
}) {
  const draft = detail.draft;

  const [title, setTitle] = useState(draft?.title ?? detail.title);
  const [body, setBody] = useState(draft?.body ?? detail.summary);
  const [telegramText, setTelegramText] = useState(draft?.telegramText ?? '');
  const [profanity, setProfanity] = useState<ProfanityReport | null>(draft?.profanityReport ?? null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(true);

  // При переключении на другое событие форма заполняется его черновиком.
  useEffect(() => {
    setTitle(draft?.title ?? detail.title);
    setBody(draft?.body ?? detail.summary);
    setTelegramText(draft?.telegramText ?? '');
    setProfanity(draft?.profanityReport ?? null);
    setNotice(null);
  }, [detail.id, draft?.id, draft?.title, draft?.body, draft?.telegramText, draft?.profanityReport, detail.title, detail.summary]);

  const save = useSaveDraft();
  const regenerate = useRegenerateDraft();
  const preview = usePreview();
  const approve = useApprove();
  const reject = useReject();
  const restore = useRestore();
  const publish = usePublish();

  const moderationStatus = detail.moderation?.status ?? 'PENDING';
  const isBlocked = moderationStatus === 'BLOCKED' || profanity?.allowed === false;
  const isApproved = moderationStatus === 'APPROVED';
  const isRejected = moderationStatus === 'REJECTED';
  const isPublished = moderationStatus === 'PUBLISHED';
  const busy =
    save.isPending || regenerate.isPending || approve.isPending || publish.isPending || reject.isPending;

  const handleSave = async () => {
    setNotice(null);
    try {
      const result = await save.mutateAsync({
        eventId: detail.id,
        title,
        body,
        telegramText: telegramText || `${title}\n\n${body}`,
      });
      setProfanity(result.profanityReport);
      setNotice(
        result.allowed
          ? { tone: 'success', text: `Сохранено, версия ${result.draft.version}.` }
          : { tone: 'danger', text: result.profanityReport.reason },
      );
    } catch (error) {
      // Ответ 409 означает, что правка сохранена, но заблокирована.
      if (error instanceof ApiError && error.isProfanityBlocked) {
        const payload = error.details as { profanityReport?: ProfanityReport } | undefined;
        if (payload?.profanityReport) setProfanity(payload.profanityReport);
        setNotice({ tone: 'danger', text: error.message });
      } else {
        setNotice({ tone: 'danger', text: (error as Error).message });
      }
    }
  };

  const handlePreview = async () => {
    setNotice(null);
    const result = await preview.mutateAsync({
      eventId: detail.id,
      title,
      body,
    });
    setTelegramText(result.telegramText);
    setProfanity(result.profanityReport);
    setShowPreview(true);
    if (!result.allowed) {
      setNotice({ tone: 'danger', text: result.profanityReport.reason });
    }
  };

  const handleRegenerate = async () => {
    setNotice(null);
    const result = await regenerate.mutateAsync(detail.id);
    setTitle(result.draft.title);
    setBody(result.draft.body);
    setTelegramText(result.draft.telegramText);
    setProfanity(result.draft.profanityReport);
    setNotice({ tone: 'success', text: `Черновик пересоздан, версия ${result.draft.version}.` });
  };

  const handleApprove = async () => {
    setNotice(null);
    try {
      await approve.mutateAsync(detail.id);
      setNotice({ tone: 'success', text: 'Материал одобрен. Теперь его можно опубликовать.' });
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };

  const handleReject = async () => {
    const reason = window.prompt('Причина отклонения:');
    if (!reason) return;
    setNotice(null);
    try {
      await reject.mutateAsync({ eventId: detail.id, reason });
      setNotice({ tone: 'warning', text: 'Материал отклонён.' });
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };

  const handleRestore = async () => {
    setNotice(null);
    try {
      await restore.mutateAsync(detail.id);
      setNotice({ tone: 'success', text: 'Материал возвращён в очередь на проверку.' });
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };

  const handlePublish = async () => {
    // Подтверждение обязательно и на стороне интерфейса, и на сервере.
    if (!window.confirm('Опубликовать материал в Telegram-канале?')) return;
    setNotice(null);
    try {
      const publication = await publish.mutateAsync(detail.id);
      setNotice({
        tone: 'success',
        text: publication.dryRun
          ? 'Сухой прогон выполнен: сообщение НЕ отправлено. Отключите TELEGRAM_PUBLISH_DRY_RUN для реальной публикации.'
          : `Опубликовано в Telegram (message_id: ${publication.telegramMessageId ?? '—'}).`,
      });
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };

  return (
    <div className="inspector">
      <header className="inspector__header">
        <span className="inspector__title">Редактирование новости</span>
        <Badge tone={isPublished ? 'success' : isBlocked ? 'danger' : isApproved ? 'info' : 'muted'}>
          {MODERATION_STATUS_LABELS[moderationStatus]}
        </Badge>
        <button type="button" className="btn btn--icon btn--ghost" onClick={onClose} aria-label="Закрыть">
          <IconClose size={16} />
        </button>
      </header>

      <div className="inspector__body">
        {notice && (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <Alert tone={notice.tone}>{notice.text}</Alert>
          </div>
        )}

        {isBlocked && profanity && !profanity.allowed && (
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <Alert tone="danger" title="Публикация заблокирована">
              {profanity.reason}
              <div style={{ marginTop: 6, fontSize: 'var(--text-sm)' }}>
                Замените отмеченные фрагменты нейтральными формулировками. Маскировка
                звёздочками не снимает блокировку.
              </div>
            </Alert>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div className="field">
            <label className="field__label" htmlFor="draft-title">
              Заголовок
            </label>
            <input
              id="draft-title"
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={300}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="draft-body">
              Текст новости
            </label>
            <textarea
              id="draft-body"
              className="textarea"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={7}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div className="field">
              <span className="field__label">Категория</span>
              <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
                {detail.category?.title ?? '—'}
              </div>
            </div>
            <div className="field">
              <span className="field__label">Приоритет</span>
              <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
                {IMPORTANCE_LABELS[detail.importance]}
              </div>
            </div>
          </div>

          {detail.locationText && (
            <div className="field">
              <span className="field__label">Геолокация</span>
              <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
                📍 {detail.locationText}
              </div>
            </div>
          )}

          <div className="field">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="field__label" style={{ flex: 1 }}>
                Предпросмотр Telegram
              </span>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => setShowPreview((value) => !value)}
              >
                {showPreview ? 'Скрыть' : 'Показать'}
              </button>
            </div>
            {showPreview && (
              <TelegramPreview
                text={telegramText || `${title}\n\n${body}`}
                media={detail.media.filter((m) => m.type === 'PHOTO')}
                channel={channel ?? null}
              />
            )}
          </div>

          {draft && draft.witnessQuotes.length > 0 && (
            <div className="field">
              <span className="field__label">Цитаты из видео</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {draft.witnessQuotes.map((quote, index) => (
                  <div key={index} className="source-chip">
                    <span className="source-chip__name">«{quote}»</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="inspector__footer">
        <button type="button" className="btn btn--sm" onClick={handleSave} disabled={busy}>
          <IconSave size={14} /> Сохранить
        </button>
        <button type="button" className="btn btn--sm" onClick={handlePreview} disabled={busy}>
          <IconEye size={14} /> Предпросмотр
        </button>
        <button type="button" className="btn btn--sm" onClick={handleRegenerate} disabled={busy}>
          <IconRefresh size={14} /> Обновить черновик
        </button>

        <div style={{ flex: 1 }} />

        {/* Отклонённый материал не потерян: его можно вернуть в очередь. */}
        {isRejected ? (
          <button type="button" className="btn btn--sm" onClick={handleRestore} disabled={busy}>
            <IconRefresh size={14} /> Вернуть в очередь
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={handleReject}
            disabled={busy || isPublished}
          >
            Отклонить
          </button>
        )}

        {!isApproved && !isPublished && !isRejected && (
          <button
            type="button"
            className="btn btn--sm btn--success"
            onClick={handleApprove}
            disabled={busy || isBlocked}
            title={isBlocked ? 'Сначала уберите запрещённую лексику' : undefined}
          >
            <IconCheck size={14} /> Одобрить
          </button>
        )}

        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={handlePublish}
          /* Публикация доступна только после одобрения — как в ТЗ §13. */
          disabled={busy || !isApproved || isPublished}
          title={
            isPublished
              ? 'Материал уже опубликован'
              : !isApproved
                ? 'Сначала одобрите материал'
                : undefined
          }
        >
          <IconTelegram size={14} /> Опубликовать
        </button>
      </footer>
    </div>
  );
}
