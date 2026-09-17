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

  // Предупреждать только о тех площадках, которые человек реально
  // использует. Раньше не настроенный ВК висел красным у всех, включая
  // тех, кто сознательно работает на одном Telegram, — предупреждение без
  // повода приучает не читать предупреждения.
  const usedTypes = new Set<string>((sources.data?.sources ?? []).map((source) => source.type));
  const blocking = adapters.filter((a) => !a.configured && usedTypes.has(a.type));
  const availableLater = adapters.filter((a) => !a.configured && !usedTypes.has(a.type));

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

        {/* Настроенность видна до попытки опроса — но только там, где она мешает. */}
        {blocking.length > 0 && (
          <Alert tone="warning" title="Источники не будут опрошены">
            <ul style={{ paddingLeft: 16, margin: '4px 0 0' }}>
              {blocking.map((a) => (
                <li key={a.type}>
                  {a.type}: {a.reason}
                </li>
              ))}
            </ul>
          </Alert>
        )}

        {/* Ненастроенная площадка без источников — не проблема, а сведение:
            показывается спокойной строкой, только когда форма открыта. */}
        {showForm && availableLater.length > 0 && (
          <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
            Пока не подключено:{' '}
            {availableLater.map((a) => a.type).join(', ')}. Источники этих
            площадок добавить не получится, остальные работают как обычно.
          </p>
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
                  placeholder={form.type === 'VK' ? 'ВК Новороссийск' : 'ТГ Новороссийск'}
                  required
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="source-username">
                  {form.type === 'VK' ? 'Адрес сообщества в ссылке' : 'Адрес канала в ссылке'}
                </label>
                <input
                  id="source-username"
                  className="input"
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                  placeholder={form.type === 'VK' ? 'nvrsk_life' : 'novorossiysk_news'}
                />
                {/* Подсказка привязана к выбранной площадке: общий текст про
                    t.me сбивал с толку при добавлении сообщества ВК, а прежние
                    подписи «Имя канала» и «Без символа @» читались как
                    название, и сюда вписывали «ЧП Новороссийск». */}
                <span className="field__hint">
                  {form.type === 'VK' ? (
                    <>
                      Не название, а часть ссылки после vk.com/ — например, из
                      <code> vk.com/nvrsk_life</code> сюда идёт
                      <code> nvrsk_life</code>. Можно указать числовой owner_id
                    </>
                  ) : (
                    <>
                      Не название, а часть ссылки после t.me/ — например, из
                      <code> t.me/chpnvrsk_official</code> сюда идёт
                      <code> chpnvrsk_official</code>. Без @ и без https://
                    </>
                  )}
                </span>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="source-url">Ссылка</label>
                <input
                  id="source-url"
                  className="input"
                  type="url"
                  value={form.url}
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                  placeholder={
                    form.type === 'VK'
                      ? 'https://vk.com/nvrsk_life'
                      : 'https://t.me/novorossiysk_news'
                  }
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
            <div className="list list--boxed" style={{ padding: 'var(--space-2) 0' }}>
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
