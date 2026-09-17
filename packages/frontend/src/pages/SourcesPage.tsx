import { useState, type FormEvent } from 'react';
import { useCreateSource, useDeleteSource, useSources, useSyncSource, useUpdateSource } from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { Alert, Badge, Panel, QueryState } from '../components/ui/primitives.jsx';
import { IconPlus, IconRefresh, IconTelegram, IconVk } from '../components/ui/Icons.jsx';
import { formatRelative, SOURCE_HEALTH_LABELS, sourceColor, sourceInitials } from '../lib/format.js';

/**
 * Управление источниками (ТЗ §1).
 *
 * При добавлении источник проверяется на доступность ДО сохранения: иначе
 * в списке появлялись бы каналы, которые никогда не отдадут публикацию.
 */
export function SourcesPage() {
  const sources = useSources();
  const create = useCreateSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const sync = useSyncSource();

  const [showForm, setShowForm] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [form, setForm] = useState({ type: 'TELEGRAM', title: '', username: '', url: '' });

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    try {
      await create.mutateAsync({
        type: form.type,
        title: form.title,
        username: form.username.replace(/^@/, '') || null,
        url: form.url,
      });
      setNotice({ tone: 'success', text: 'Источник добавлен, выполняется первый опрос.' });
      setForm({ type: 'TELEGRAM', title: '', username: '', url: '' });
      setShowForm(false);
    } catch (error) {
      setNotice({ tone: 'danger', text: (error as Error).message });
    }
  };

  const handleSync = async (id: string) => {
    const result = await sync.mutateAsync(id);
    setNotice({ tone: 'success', text: result.message });
  };

  const adapters = sources.data?.adapters ?? [];

  return (
    <>
      <PageHeader
        title="Источники"
        subtitle="Публичные Telegram-каналы и сообщества VK"
        actions={
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setShowForm((v) => !v)}>
            <IconPlus size={14} /> Добавить
          </button>
        }
      />

      <div className="workspace stack">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

        {/* Состояние адаптеров: настроенность видна сразу, до попытки опроса. */}
        {adapters.some((a) => !a.configured) && (
          <Alert tone="warning" title="Не все типы источников настроены">
            <ul style={{ paddingLeft: 16, margin: '4px 0 0' }}>
              {adapters
                .filter((a) => !a.configured)
                .map((a) => (
                  <li key={a.type}>
                    {a.type}: {a.reason}
                  </li>
                ))}
            </ul>
          </Alert>
        )}

        {showForm && (
          <Panel title="Новый источник">
            <form
              onSubmit={handleCreate}
              style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: 560 }}
            >
              <div className="field">
                <label className="field__label" htmlFor="source-type">Платформа</label>
                <select
                  id="source-type"
                  className="select"
                  value={form.type}
                  onChange={(event) => setForm({ ...form, type: event.target.value })}
                >
                  <option value="TELEGRAM">Telegram-канал</option>
                  <option value="VK">Сообщество VK</option>
                </select>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="source-title">Название</label>
                <input
                  id="source-title"
                  className="input"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  placeholder="ТГ Новороссийск"
                  required
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="source-username">
                  Имя канала или сообщества
                </label>
                <input
                  id="source-username"
                  className="input"
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                  placeholder="novorossiysk_news"
                />
                <span className="field__hint">Без символа @</span>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="source-url">Ссылка</label>
                <input
                  id="source-url"
                  className="input"
                  type="url"
                  value={form.url}
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                  placeholder="https://t.me/novorossiysk_news"
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <button type="submit" className="btn btn--primary" disabled={create.isPending}>
                  {create.isPending ? 'Проверка доступности…' : 'Добавить источник'}
                </button>
                <button type="button" className="btn" onClick={() => setShowForm(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </Panel>
        )}

        <Panel title="Подключённые источники" flush>
          <QueryState
            isLoading={sources.isLoading}
            error={sources.error}
            isEmpty={(sources.data?.sources.length ?? 0) === 0}
            emptyTitle="Источники не добавлены"
            emptyHint="Добавьте первый Telegram-канал или сообщество VK, чтобы начать сбор новостей."
          >
            <div className="list" style={{ padding: 'var(--space-2) 0' }}>
              {sources.data?.sources.map((source) => (
                <div key={source.id} className="list-row" style={{ cursor: 'default' }}>
                  <span className="list-row__avatar" style={{ background: sourceColor(source.id) }}>
                    {source.type === 'TELEGRAM' ? <IconTelegram size={13} /> : <IconVk size={13} />}
                  </span>

                  <span className="list-row__body">
                    <span className="list-row__title">
                      {source.title}
                      {!source.isActive && (
                        <>
                          {' '}
                          <Badge tone="muted">выключен</Badge>
                        </>
                      )}
                    </span>
                    <span className="list-row__meta">
                      {source.username ? `@${source.username}` : source.url} · публикаций:{' '}
                      {source.postsFetched} · последняя синхронизация:{' '}
                      {formatRelative(source.lastSuccessfulSyncAt)}
                    </span>
                    {source.lastError && (
                      <span className="list-row__meta" style={{ color: 'var(--danger)' }}>
                        {source.lastError}
                      </span>
                    )}
                  </span>

                  <Badge
                    tone={
                      source.health === 'HEALTHY'
                        ? 'success'
                        : source.health === 'FAILING'
                          ? 'danger'
                          : source.health === 'DEGRADED'
                            ? 'warning'
                            : 'muted'
                    }
                  >
                    {SOURCE_HEALTH_LABELS[source.health] ?? source.health}
                  </Badge>

                  <button
                    type="button"
                    className="btn btn--sm btn--icon"
                    onClick={() => void handleSync(source.id)}
                    title="Опросить сейчас"
                  >
                    <IconRefresh size={14} />
                  </button>

                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => update.mutate({ id: source.id, isActive: !source.isActive })}
                  >
                    {source.isActive ? 'Выключить' : 'Включить'}
                  </button>

                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => {
                      if (window.confirm(`Удалить источник «${source.title}» и все его публикации?`)) {
                        remove.mutate(source.id);
                      }
                    }}
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          </QueryState>
        </Panel>
      </div>
    </>
  );
}
