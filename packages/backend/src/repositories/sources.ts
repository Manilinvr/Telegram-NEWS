import type { Source, SourceConfig, SourceHealth, SourceType } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapSource } from './mappers.js';

export class SourcesRepository {
  constructor(private readonly db: Database) {}

  async list(options: { activeOnly?: boolean } = {}): Promise<Source[]> {
    const rows = await this.db.many(
      `SELECT * FROM sources
        WHERE (NOT $1::boolean OR is_active)
        ORDER BY title`,
      [options.activeOnly ?? false],
    );
    return rows.map(mapSource);
  }

  async findById(id: string): Promise<Source | null> {
    const row = await this.db.maybeOne('SELECT * FROM sources WHERE id = $1', [id]);
    return row ? mapSource(row) : null;
  }

  /**
   * Источники, которые пора опросить.
   *
   * Опрашивается источник, у которого с последней синхронизации прошло
   * больше его собственного интервала. Отключённые источники и источники
   * со статусом DISABLED не выбираются.
   */
  async findDueForSync(limit = 50): Promise<Source[]> {
    const rows = await this.db.many(
      `SELECT * FROM sources
        WHERE is_active
          AND health <> 'DISABLED'
          AND (
            last_sync_at IS NULL
            OR last_sync_at < now() - make_interval(secs => poll_interval_seconds)
          )
        ORDER BY last_sync_at NULLS FIRST
        LIMIT $1`,
      [limit],
    );
    return rows.map(mapSource);
  }

  async create(input: {
    type: SourceType;
    title: string;
    username?: string | null;
    externalId?: string | null;
    url: string;
    pollIntervalSeconds?: number;
    config?: SourceConfig;
    notes?: string | null;
  }): Promise<Source> {
    const row = await this.db.one(
      `INSERT INTO sources (type, title, username, external_id, url, poll_interval_seconds, config, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.type,
        input.title,
        input.username ?? null,
        input.externalId ?? null,
        input.url,
        input.pollIntervalSeconds ?? 60,
        JSON.stringify(input.config ?? {}),
        input.notes ?? null,
      ],
    );
    return mapSource(row);
  }

  async update(id: string, patch: Partial<Source>): Promise<Source | null> {
    const row = await this.db.maybeOne(
      `UPDATE sources SET
         title                 = COALESCE($2, title),
         username              = COALESCE($3, username),
         external_id           = COALESCE($4, external_id),
         url                   = COALESCE($5, url),
         is_active             = COALESCE($6, is_active),
         poll_interval_seconds = COALESCE($7, poll_interval_seconds),
         config                = COALESCE($8::jsonb, config),
         notes                 = COALESCE($9, notes),
         health                = COALESCE($10, health)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.title ?? null,
        patch.username ?? null,
        patch.externalId ?? null,
        patch.url ?? null,
        patch.isActive ?? null,
        patch.pollIntervalSeconds ?? null,
        patch.config ? JSON.stringify(patch.config) : null,
        patch.notes ?? null,
        patch.health ?? null,
      ],
    );
    return row ? mapSource(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM sources WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Отметить начало опроса. */
  async markSyncStarted(id: string): Promise<void> {
    await this.db.query('UPDATE sources SET last_sync_at = now() WHERE id = $1', [id]);
  }

  /**
   * Зафиксировать успешный опрос: сбросить счётчик ошибок, обновить курсор
   * и вернуть источник в здоровое состояние.
   */
  async markSyncSuccess(
    id: string,
    input: { fetched: number; lastExternalId?: string | null; lastPostAt?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE sources SET
         last_successful_sync_at = now(),
         last_sync_at            = now(),
         posts_fetched           = posts_fetched + $2,
         last_external_id        = COALESCE($3, last_external_id),
         -- Берём максимум: публикации могут прийти не по порядку.
         last_post_at            = GREATEST(last_post_at, $4::timestamptz),
         consecutive_failures    = 0,
         health                  = 'HEALTHY',
         last_error              = NULL,
         last_error_at           = NULL
       WHERE id = $1`,
      [id, input.fetched, input.lastExternalId ?? null, input.lastPostAt ?? null],
    );
  }

  /**
   * Зафиксировать сбой опроса.
   *
   * Источник деградирует постепенно: первые сбои переводят его в DEGRADED,
   * а устойчивые — в FAILING. Отказ одного источника не влияет на остальные
   * (ТЗ §24): источник не отключается автоматически, чтобы временная
   * недоступность платформы не привела к молчаливой потере канала.
   */
  async markSyncFailure(id: string, error: string): Promise<SourceHealth> {
    const row = await this.db.one(
      `UPDATE sources SET
         last_sync_at         = now(),
         consecutive_failures = consecutive_failures + 1,
         last_error           = $2,
         last_error_at        = now(),
         health = CASE
           WHEN consecutive_failures + 1 >= 5 THEN 'FAILING'
           ELSE 'DEGRADED'
         END
       WHERE id = $1
       RETURNING health`,
      [id, error.slice(0, 2000)],
    );
    return String(row.health) as SourceHealth;
  }

  async getLastExternalId(id: string): Promise<string | null> {
    const row = await this.db.maybeOne('SELECT last_external_id FROM sources WHERE id = $1', [id]);
    return row?.last_external_id ? String(row.last_external_id) : null;
  }
}
