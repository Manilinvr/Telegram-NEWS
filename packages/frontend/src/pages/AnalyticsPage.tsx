import { useState } from 'react';
import { useDashboard, useJobs, useProcessingErrors, useResolveErrors } from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { LineChart } from '../components/charts/LineChart.jsx';
import { DonutChart } from '../components/charts/DonutChart.jsx';
import { Badge, Panel, QueryState, Segmented, StatTile } from '../components/ui/primitives.jsx';
import { formatDateTime, formatRelative, SOURCE_HEALTH_LABELS } from '../lib/format.js';

/** Аналитика и диагностика (ТЗ §15, §23). */
export function AnalyticsPage() {
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('7d');
  const dashboard = useDashboard(period);
  const errors = useProcessingErrors();
  const resolveErrors = useResolveErrors();
  const jobs = useJobs();

  const summary = dashboard.data?.summary;

  // Одинаковые ошибки сворачиваются в одну строку со счётчиком.
  // Сбой обычно повторяется на каждой публикации, и список из сотни
  // одинаковых записей скрывал все остальные ошибки — при том, что
  // разных причин там было две-три.
  const errorGroups = Object.values(
    (errors.data ?? []).reduce<
      Record<
        string,
        {
          key: string;
          stage: string;
          message: string;
          reason: string | null;
          count: number;
          lastAt: string;
        }
      >
    >((acc, error) => {
      const key = `${error.stage}|${error.message}`;
      // Подробность сбоя — то, ради чего в журнал и смотрят: «модель не
      // ответила» без ответа службы не подсказывает, что делать.
      const reason =
        typeof error.details?.reason === 'string' && error.details.reason.trim().length > 0
          ? error.details.reason
          : null;
      const existing = acc[key];
      if (existing) {
        existing.count += 1;
        if (error.createdAt > existing.lastAt) {
          existing.lastAt = error.createdAt;
          if (reason) existing.reason = reason;
        }
      } else {
        acc[key] = {
          key,
          stage: error.stage,
          message: error.message,
          reason,
          count: 1,
          lastAt: error.createdAt,
        };
      }
      return acc;
    }, {}),
  ).sort((a, b) => (a.lastAt > b.lastAt ? -1 : 1));

  return (
    <>
      <PageHeader title="Аналитика" subtitle="Показатели сбора, обработки и публикации" />

      <div className="workspace stack">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <StatTile label="Источников активно" value={summary?.sources.active ?? 0} />
          <StatTile
            label="Публикаций за сутки"
            value={summary?.posts.last24h ?? 0}
            delta={summary?.posts.deltaVsPrev24h}
          />
          <StatTile
            label="Событий за сутки"
            value={summary?.events.last24h ?? 0}
            delta={summary?.events.deltaVsPrev24h}
          />
          <StatTile label="В очереди модерации" value={summary?.moderation.pending ?? 0} />
          <StatTile label="Опубликовано за сутки" value={summary?.publications.last24h ?? 0} />
          <StatTile label="Ошибок не решено" value={summary?.errors.unresolved ?? 0} />
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
          <Panel
            title="Публикации и события по времени"
            actions={
              <Segmented
                value={period}
                onChange={setPeriod}
                options={[
                  { value: '24h', label: '24ч' },
                  { value: '7d', label: '7д' },
                  { value: '30d', label: '30д' },
                ]}
              />
            }
          >
            <QueryState isLoading={dashboard.isLoading} error={dashboard.error}>
              <LineChart points={dashboard.data?.timeseries ?? []} height={230} />
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-4)',
                  marginTop: 'var(--space-3)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-muted)',
                }}
              >
                <span>
                  <span style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--accent)', verticalAlign: 'middle', marginRight: 6 }} />
                  Публикации
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--info)', verticalAlign: 'middle', marginRight: 6 }} />
                  События
                </span>
              </div>
            </QueryState>
          </Panel>

          <Panel title="Распределение по категориям">
            <QueryState isLoading={dashboard.isLoading} error={dashboard.error}>
              <DonutChart items={dashboard.data?.categories ?? []} size={140} />
            </QueryState>
          </Panel>
        </div>

        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
          <Panel title="Активность источников" flush>
            <QueryState
              isLoading={dashboard.isLoading}
              error={dashboard.error}
              isEmpty={(dashboard.data?.topSources.length ?? 0) === 0}
              emptyTitle="Нет данных"
            >
              <div className="list" style={{ paddingBottom: 'var(--space-3)' }}>
                {dashboard.data?.topSources.map((source) => (
                  <div key={source.sourceId} className="list-row" style={{ cursor: 'default' }}>
                    <span className="list-row__body">
                      <span className="list-row__title">{source.title}</span>
                      <span className="list-row__meta">
                        {SOURCE_HEALTH_LABELS[source.health]} · последняя публикация{' '}
                        {formatRelative(source.lastPostAt)}
                      </span>
                    </span>
                    <span className="list-row__value">{source.postCount}</span>
                  </div>
                ))}
              </div>
            </QueryState>
          </Panel>

          <Panel
            title="Ошибки обработки"
            actions={
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                {(errors.data?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={resolveErrors.isPending}
                    title="Пометить все ошибки разобранными. Записи остаются в журнале."
                    onClick={() => resolveErrors.mutate({})}
                  >
                    {resolveErrors.isPending ? 'Убираем…' : 'Отметить решёнными'}
                  </button>
                )}
                <Badge tone={(errors.data?.length ?? 0) > 0 ? 'danger' : 'success'}>
                  {errors.data?.length ?? 0}
                </Badge>
              </span>
            }
            flush
          >
            <QueryState
              isLoading={errors.isLoading}
              error={errors.error}
              isEmpty={errorGroups.length === 0}
              emptyTitle="Ошибок нет"
              emptyHint="Все этапы обработки отработали без сбоев."
            >
              <div className="list" style={{ paddingBottom: 'var(--space-3)' }}>
                {errorGroups.slice(0, 12).map((group) => (
                  <div
                    key={group.key}
                    className="list-row"
                    style={{ cursor: 'default' }}
                    title={group.reason ? `${group.message}\n\n${group.reason}` : group.message}
                  >
                    <Badge tone="danger">{group.stage}</Badge>
                    <span className="list-row__body">
                      <span className="list-row__title">{group.message}</span>
                      {group.reason && (
                        <span
                          className="list-row__meta"
                          style={{ color: 'var(--text-secondary)', whiteSpace: 'normal' }}
                        >
                          {group.reason}
                        </span>
                      )}
                      <span className="list-row__meta">
                        {group.count > 1 ? `${group.count} раз · последний ` : ''}
                        {formatDateTime(group.lastAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={resolveErrors.isPending}
                      title="Убрать только эти повторы"
                      onClick={() =>
                        resolveErrors.mutate({ stage: group.stage, message: group.message })
                      }
                    >
                      Убрать
                    </button>
                  </div>
                ))}
              </div>
            </QueryState>
          </Panel>
        </div>

        <Panel title="Очередь задач" flush>
          <QueryState isLoading={jobs.isLoading} error={jobs.error}>
            <div style={{ display: 'flex', gap: 'var(--space-3)', padding: '0 var(--space-4) var(--space-3)' }}>
              <Badge tone="info">в очереди: {jobs.data?.counts.queued ?? 0}</Badge>
              <Badge tone="warning">выполняется: {jobs.data?.counts.running ?? 0}</Badge>
              <Badge tone="danger">с ошибкой: {jobs.data?.counts.failed ?? 0}</Badge>
            </div>
            <div className="list" style={{ paddingBottom: 'var(--space-3)' }}>
              {jobs.data?.jobs.slice(0, 15).map((job) => (
                <div key={job.id} className="list-row" style={{ cursor: 'default' }}>
                  <Badge
                    tone={
                      job.status === 'COMPLETED'
                        ? 'success'
                        : job.status === 'DEAD' || job.status === 'FAILED'
                          ? 'danger'
                          : 'muted'
                    }
                  >
                    {job.status}
                  </Badge>
                  <span className="list-row__body">
                    <span className="list-row__title">{job.type}</span>
                    <span className="list-row__meta">
                      попыток: {job.attempts}/{job.maxAttempts}
                      {job.lastError ? ` · ${job.lastError}` : ''}
                    </span>
                  </span>
                  <span className="list-row__time">{formatRelative(job.createdAt)}</span>
                </div>
              ))}
            </div>
          </QueryState>
        </Panel>
      </div>
    </>
  );
}
