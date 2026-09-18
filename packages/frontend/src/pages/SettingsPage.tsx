import { useEffect, useState } from 'react';
import {
  DEFAULT_EDITORIAL_STYLE,
  EDITORIAL_TONES,
  EDITORIAL_TONE_HINTS,
  EDITORIAL_TONE_LABELS,
  type EditorialStyle,
} from '@nnm/shared';
import {
  useAiCheck,
  useAuditLog,
  useCategories,
  useChangePassword,
  useDiagnostics,
  useLogout,
  useProfanityTest,
  useSettings,
  useUpdateSetting,
} from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { Alert, Badge, Panel, QueryState } from '../components/ui/primitives.jsx';
import { IconLogout, IconShield } from '../components/ui/Icons.jsx';
import { formatDateTime } from '../lib/format.js';

/**
 * Настройки (ТЗ §32).
 *
 * Критичные разделы требуют повторного ввода пароля. Фильтр лексики можно
 * расширить и настроить политику по грубой брани, но выключить проверку
 * мата нельзя — такой настройки нет ни здесь, ни в API.
 */
export function SettingsPage() {
  const settings = useSettings();
  const diagnostics = useDiagnostics();
  const categories = useCategories();
  const audit = useAuditLog();
  const updateSetting = useUpdateSetting();
  const profanityTest = useProfanityTest();
  const aiCheck = useAiCheck();
  const changePassword = useChangePassword();
  const logout = useLogout();

  const [tab, setTab] = useState<'general' | 'style' | 'profanity' | 'security' | 'audit'>('general');
  const [testText, setTestText] = useState('');

  // Форма стиля заполняется сохранённым значением, когда настройки
  // подгрузились. Правки пользователя после этого не затираются: подмена
  // текста под курсором посреди набора — верный способ потерять абзац.
  const [style, setStyle] = useState<EditorialStyle>(DEFAULT_EDITORIAL_STYLE);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const stored = settings.data?.settings as Record<string, unknown> | undefined;

  useEffect(() => {
    if (styleLoaded || !stored) return;
    const saved = stored.editorial as Partial<EditorialStyle> | undefined;
    if (saved) setStyle({ ...DEFAULT_EDITORIAL_STYLE, ...saved });
    setStyleLoaded(true);
  }, [stored, styleLoaded]);

  const saveStyle = async () => {
    setNotice(null);
    try {
      await updateSetting.mutateAsync({ key: 'editorial', value: style });
      setNotice({
        tone: 'success',
        text: 'Стиль сохранён. Он применится к черновикам, которые будут созданы дальше; уже готовые можно пересобрать кнопкой «Пересоздать черновик» в карточке события.',
      });
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };
  const [passwords, setPasswords] = useState({ current: '', next: '', repeat: '' });
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const runtime = settings.data?.runtime as Record<string, never> | undefined;

  const handlePasswordChange = async () => {
    setNotice(null);
    if (passwords.next !== passwords.repeat) {
      setNotice({ tone: 'danger', text: 'Новый пароль и подтверждение не совпадают.' });
      return;
    }
    try {
      await changePassword.mutateAsync({
        currentPassword: passwords.current,
        newPassword: passwords.next,
      });
      setNotice({ tone: 'success', text: 'Пароль изменён. Сейчас потребуется войти заново.' });
      setTimeout(() => window.location.reload(), 1800);
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };

  return (
    <>
      <PageHeader
        title="Настройки"
        subtitle="Конфигурация системы, фильтров и безопасности"
        actions={
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              void logout.mutateAsync().then(() => window.location.reload());
            }}
          >
            <IconLogout size={14} /> Выйти
          </button>
        }
      />

      <div className="workspace stack">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

        <div className="panel">
          <div className="tabs">
            {(
              [
                ['general', 'Общие'],
                ['style', 'Стиль'],
                ['profanity', 'Фильтр лексики'],
                ['security', 'Безопасность'],
                ['audit', 'Журнал действий'],
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

          <div className="panel__body" style={{ paddingTop: 'var(--space-4)' }}>
            {tab === 'general' && (
              <QueryState isLoading={settings.isLoading} error={settings.error}>
                <div className="detail-section">
                  <div className="detail-section__title">Текущая конфигурация</div>
                  <div className="info-grid" style={{ maxWidth: 620 }}>
                    <span className="info-grid__key">Провайдер AI</span>
                    <span className="info-grid__value">
                      {String(runtime?.aiProvider ?? '—')}
                      {runtime?.aiProvider === 'mock' ? (
                        <>
                          {' '}
                          <Badge tone="warning">правила вместо модели</Badge>
                        </>
                      ) : runtime?.aiReason ? (
                        <>
                          {' '}
                          <Badge tone="danger">не настроен: {String(runtime.aiReason)}</Badge>
                        </>
                      ) : (
                        <>
                          {' '}
                          <Badge tone="success">настроен</Badge>
                        </>
                      )}
                    </span>
                    <span className="info-grid__key">Модель</span>
                    <span className="info-grid__value">{String(runtime?.aiModel ?? '—')}</span>
                    <span className="info-grid__key">Эмбеддинги</span>
                    <span className="info-grid__value">{String(runtime?.embeddingProvider ?? '—')}</span>
                    <span className="info-grid__key">Транскрипция</span>
                    <span className="info-grid__value">{String(runtime?.transcriptionProvider ?? '—')}</span>
                    <span className="info-grid__key">Режим Telegram</span>
                    <span className="info-grid__value">{String(runtime?.telegramIngestMode ?? '—')}</span>
                    <span className="info-grid__key">Канал публикации</span>
                    <span className="info-grid__value">
                      {String(runtime?.telegramPublishChannel ?? 'не задан')}
                    </span>
                    <span className="info-grid__key">Сухой прогон публикации</span>
                    <span className="info-grid__value">
                      {runtime?.telegramPublishDryRun ? (
                        <Badge tone="warning">включён — сообщения не отправляются</Badge>
                      ) : (
                        <Badge tone="success">выключен — публикация реальная</Badge>
                      )}
                    </span>
                    <span className="info-grid__key">Автопубликация</span>
                    <span className="info-grid__value">
                      <Badge tone="muted">
                        {runtime?.autoPublishEnabled ? 'включена' : 'выключена (требуется подтверждение человека)'}
                      </Badge>
                    </span>
                    <span className="info-grid__key">Хранилище медиа</span>
                    <span className="info-grid__value">{String(runtime?.storageDriver ?? '—')}</span>
                  </div>
                </div>

                <div className="detail-section">
                  <div className="detail-section__title">Проверка связи с моделью</div>
                  <p className="field__hint">
                    Настройки модели задаются переменными окружения на хостинге, и опечатка
                    в ключе или названии модели не видна: система продолжает работать по
                    правилам и выглядит исправной. Кнопка отправляет один короткий запрос
                    и показывает ответ службы как есть.
                  </p>
                  <button
                    type="button"
                    className="btn btn--primary"
                    style={{ marginTop: 'var(--space-2)' }}
                    disabled={aiCheck.isPending}
                    onClick={() => aiCheck.mutate()}
                  >
                    {aiCheck.isPending ? 'Проверяем…' : 'Проверить модель'}
                  </button>

                  {aiCheck.data && (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <Alert tone={aiCheck.data.ok ? 'success' : 'danger'}>
                        {aiCheck.data.ok
                          ? `Модель ${aiCheck.data.model ?? ''} ответила за ${aiCheck.data.ms ?? 0} мс — разбор идёт моделью.`
                          : `Модель не отвечает: ${aiCheck.data.reason ?? 'причина не указана'} Пока это так, разбор идёт по правилам.`}
                      </Alert>
                    </div>
                  )}
                  {aiCheck.error && (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <Alert tone="danger">{(aiCheck.error as Error).message}</Alert>
                    </div>
                  )}
                </div>

                <div className="detail-section">
                  <div className="detail-section__title">Категории ({categories.data?.length ?? 0})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {categories.data?.map((category) => (
                      <Badge key={category.slug} color={category.color}>
                        {category.emoji} {category.title}
                      </Badge>
                    ))}
                  </div>
                  <p className="field__hint" style={{ marginTop: 8 }}>
                    Категории расширяются без изменения архитектуры: код не ветвится по
                    конкретной категории.
                  </p>
                </div>
              </QueryState>
            )}

            {tab === 'style' && (
              <QueryState isLoading={settings.isLoading} error={settings.error}>
                <Alert tone="default" title="Стиль меняет подачу, а не факты">
                  Эти настройки управляют тоном, длиной и оформлением. Правила работы с
                  фактами они не отменяют: выдумывать сведения, скрывать их происхождение
                  и использовать запрещённую лексику модель не может ни по какому
                  указанию — это проверяется на стороне системы, а не доверяется модели.
                </Alert>

                <div
                  className="detail-section"
                  style={{ marginTop: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)', maxWidth: 620 }}
                >
                  <div className="field">
                    <label className="field__label" htmlFor="style-tone">Тон</label>
                    <select
                      id="style-tone"
                      className="select"
                      value={style.tone}
                      onChange={(event) =>
                        setStyle({ ...style, tone: event.target.value as EditorialStyle['tone'] })
                      }
                    >
                      {EDITORIAL_TONES.map((tone) => (
                        <option key={tone} value={tone}>
                          {EDITORIAL_TONE_LABELS[tone]}
                        </option>
                      ))}
                    </select>
                    <p className="field__hint">{EDITORIAL_TONE_HINTS[style.tone]}</p>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="style-sentences">
                      Длина краткого изложения
                    </label>
                    <select
                      id="style-sentences"
                      className="select"
                      value={style.summaryMaxSentences}
                      onChange={(event) =>
                        setStyle({ ...style, summaryMaxSentences: Number(event.target.value) })
                      }
                    >
                      {[1, 2, 3, 4, 5, 6].map((value) => (
                        <option key={value} value={value}>
                          до {value} предложений
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label className="field__label" htmlFor="style-signature">
                      Подпись в конце поста
                    </label>
                    <input
                      id="style-signature"
                      className="input"
                      value={style.signature ?? ''}
                      maxLength={80}
                      placeholder="@novotoday — оставьте пустым, чтобы не подписывать"
                      onChange={(event) =>
                        setStyle({ ...style, signature: event.target.value.trim() ? event.target.value : null })
                      }
                    />
                  </div>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      gap: 8,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={style.useEmoji}
                      onChange={(event) => setStyle({ ...style, useEmoji: event.target.checked })}
                    />
                    <span>Значки в посте (📍 место, 🕒 время, 🎥 очевидцы)</span>
                  </label>

                  <div className="field">
                    <label className="field__label" htmlFor="style-extra">
                      Дополнительные указания редакции
                    </label>
                    <textarea
                      id="style-extra"
                      className="textarea"
                      rows={6}
                      maxLength={2000}
                      value={style.extraInstructions}
                      placeholder={'Например:\nРайоны называть так, как их называют жители: Мысхако, Шесхарис, Южный.\nНе писать «сообщается» — писать, кто именно сообщил.\nНе использовать слово «шок» и подобные.'}
                      onChange={(event) => setStyle({ ...style, extraInstructions: event.target.value })}
                    />
                    <p className="field__hint">
                      {style.extraInstructions.length} из 2000 символов. Пишите конкретно: «не
                      употреблять слово X», «район называть Y» — такие указания модель
                      выполняет заметно лучше, чем общее «пиши интереснее».
                    </p>
                  </div>

                  <div>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={updateSetting.isPending}
                      onClick={() => void saveStyle()}
                    >
                      {updateSetting.isPending ? 'Сохраняем…' : 'Сохранить стиль'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      style={{ marginLeft: 'var(--space-2)' }}
                      onClick={() => setStyle(DEFAULT_EDITORIAL_STYLE)}
                    >
                      Вернуть значения по умолчанию
                    </button>
                  </div>
                </div>
              </QueryState>
            )}

            {tab === 'profanity' && (
              <>
                <Alert tone="warning" title="Проверку мата отключить нельзя">
                  Фильтр запрещённой лексики — обязательная часть конвейера. В интерфейсе и
                  в API отсутствует возможность его выключить: настраивается только политика
                  по грубой брани и списки дополнительных слов.
                </Alert>

                <div className="detail-section" style={{ marginTop: 'var(--space-4)' }}>
                  <div className="detail-section__title">Проверка текста</div>
                  <textarea
                    className="textarea"
                    value={testText}
                    onChange={(event) => setTestText(event.target.value)}
                    placeholder="Вставьте текст, чтобы проверить, пройдёт ли он фильтр…"
                    rows={4}
                  />
                  <button
                    type="button"
                    className="btn btn--primary"
                    style={{ marginTop: 'var(--space-2)' }}
                    disabled={!testText.trim() || profanityTest.isPending}
                    onClick={() => profanityTest.mutate(testText)}
                  >
                    Проверить
                  </button>

                  {profanityTest.data && (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <Alert tone={profanityTest.data.allowed ? 'success' : 'danger'}>
                        {profanityTest.data.reason}
                      </Alert>
                      {profanityTest.data.matches.length > 0 && (
                        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {profanityTest.data.matches.map((match, index) => (
                            <Badge key={index} tone={match.severity === 'BLOCK' ? 'danger' : 'warning'}>
                              «{match.original}» — {match.rule}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {tab === 'security' && (
              <>
                <div className="detail-section">
                  <div className="detail-section__title">
                    <IconShield size={13} /> Смена пароля
                  </div>
                  <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 420 }}>
                    <div className="field">
                      <label className="field__label" htmlFor="pw-current">Текущий пароль</label>
                      <input
                        id="pw-current"
                        className="input"
                        type="password"
                        autoComplete="current-password"
                        value={passwords.current}
                        onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="pw-next">Новый пароль</label>
                      <input
                        id="pw-next"
                        className="input"
                        type="password"
                        autoComplete="new-password"
                        value={passwords.next}
                        onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                      />
                      <span className="field__hint">Не менее 12 символов. Длинная фраза надёжнее короткого набора символов.</span>
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="pw-repeat">Повторите пароль</label>
                      <input
                        id="pw-repeat"
                        className="input"
                        type="password"
                        autoComplete="new-password"
                        value={passwords.repeat}
                        onChange={(e) => setPasswords({ ...passwords, repeat: e.target.value })}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={handlePasswordChange}
                      disabled={changePassword.isPending || !passwords.current || !passwords.next}
                    >
                      Сменить пароль
                    </button>
                    <p className="field__hint">
                      После смены пароля все активные сессии будут завершены — включая текущую.
                    </p>
                  </div>
                </div>

                <div className="detail-section">
                  <div className="detail-section__title">Состояние подсистем</div>
                  <QueryState isLoading={diagnostics.isLoading} error={diagnostics.error}>
                    <pre
                      style={{
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius)',
                        padding: 'var(--space-3)',
                        fontSize: 'var(--text-sm)',
                        overflowX: 'auto',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {JSON.stringify(diagnostics.data ?? {}, null, 2)}
                    </pre>
                  </QueryState>
                </div>
              </>
            )}

            {tab === 'audit' && (
              <QueryState
                isLoading={audit.isLoading}
                error={audit.error}
                isEmpty={(audit.data?.length ?? 0) === 0}
                emptyTitle="Записей нет"
              >
                <div className="list">
                  {audit.data?.slice(0, 80).map((entry) => (
                    <div key={entry.id} className="list-row" style={{ cursor: 'default' }}>
                      <Badge
                        tone={
                          entry.action.includes('blocked') || entry.action.includes('failed')
                            ? 'danger'
                            : entry.action.includes('success') || entry.action.includes('approved')
                              ? 'success'
                              : 'muted'
                        }
                      >
                        {entry.action}
                      </Badge>
                      <span className="list-row__body">
                        <span className="list-row__meta">
                          {entry.entityType ?? '—'} {entry.entityId?.slice(0, 8) ?? ''} · {entry.ipAddress ?? '—'}
                        </span>
                      </span>
                      <span className="list-row__time">{formatDateTime(entry.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </QueryState>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
