import { useState } from 'react';
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

  const [tab, setTab] = useState<'general' | 'profanity' | 'security' | 'audit'>('general');
  const [testText, setTestText] = useState('');
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
