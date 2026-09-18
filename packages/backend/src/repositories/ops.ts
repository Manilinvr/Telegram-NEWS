import type { PipelineStage, ProcessingError } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapProcessingError } from './mappers.js';

/**
 * Диагностика и эксплуатация: ошибки этапов, история обработки, настройки.
 *
 * Ошибка отдельного этапа фиксируется здесь и НЕ прерывает pipeline
 * (ТЗ §24): видео без транскрипции всё равно даёт событие, недоступный
 * источник не мешает остальным.
 */
export class OpsRepository {
  constructor(private readonly db: Database) {}

  async recordError(input: {
    stage: PipelineStage;
    entityType: string;
    entityId?: string | null;
    sourceId?: string | null;
    jobId?: string | null;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO processing_errors (stage, entity_type, entity_id, source_id, job_id, message, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.stage,
        input.entityType,
        input.entityId ?? null,
        input.sourceId ?? null,
        input.jobId ?? null,
        input.message.slice(0, 4000),
        JSON.stringify(input.details ?? {}),
      ],
    );
  }

  async listErrors(options: { unresolvedOnly?: boolean; limit?: number } = {}): Promise<
    ProcessingError[]
  > {
    const rows = await this.db.many(
      `SELECT * FROM processing_errors
        WHERE (NOT $1::boolean OR NOT is_resolved)
        ORDER BY created_at DESC
        LIMIT $2`,
      [options.unresolvedOnly ?? true, options.limit ?? 100],
    );
    return rows.map(mapProcessingError);
  }

  /**
   * Закрыть все неразобранные ошибки разом.
   *
   * Нужно потому, что исправленная причина не убирает уже записанные
   * ошибки: после починки в журнале остаются сотни одинаковых записей от
   * прежней версии, и на их фоне не видно новую, настоящую. Закрывать их
   * по одной бессмысленно — они отличаются только временем.
   *
   * Записи не удаляются, а помечаются разобранными: журнал ошибок — это
   * доказательство того, что происходило, и терять его нельзя.
   */
  /**
   * Записать ошибку не чаще одного раза в заданное окно.
   *
   * Нужно для сбоев, которые повторяются на каждой публикации: если
   * модель недоступна, сотня одинаковых записей за час не добавляет
   * знания, а скрывает все остальные ошибки. Одна запись с указанием
   * причины говорит ровно то же самое.
   */
  async recordErrorOnce(
    input: {
      stage: PipelineStage;
      entityType: string;
      entityId?: string | null;
      message: string;
      details?: Record<string, unknown>;
    },
    withinMinutes: number,
  ): Promise<boolean> {
    const existing = await this.db.maybeOne(
      `SELECT id FROM processing_errors
        WHERE message = $1
          AND NOT is_resolved
          AND created_at > now() - ($2::int * interval '1 minute')
        LIMIT 1`,
      [input.message.slice(0, 4000), withinMinutes],
    );
    if (existing) return false;

    await this.recordError(input);
    return true;
  }

  /** Когда в последний раз записывалась ошибка с таким текстом. */
  async lastErrorAt(message: string): Promise<Date | null> {
    const row = await this.db.maybeOne(
      `SELECT created_at FROM processing_errors
        WHERE message = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [message.slice(0, 4000)],
    );
    return row ? new Date(String(row.created_at)) : null;
  }

  async resolveAllErrors(filter: { stage?: string; message?: string } = {}): Promise<number> {
    const result = await this.db.query(
      `UPDATE processing_errors
          SET is_resolved = true, resolved_at = now()
        WHERE NOT is_resolved
          AND ($1::text IS NULL OR stage = $1)
          AND ($2::text IS NULL OR message = $2)`,
      [filter.stage ?? null, filter.message ?? null],
    );
    return result.rowCount ?? 0;
  }

  async resolveError(id: string): Promise<void> {
    await this.db.query(
      'UPDATE processing_errors SET is_resolved = true, resolved_at = now() WHERE id = $1',
      [id],
    );
  }

  async errorCounts(): Promise<{ unresolved: number; last24h: number }> {
    const row = await this.db.one(
      `SELECT
         count(*) FILTER (WHERE NOT is_resolved)::int AS unresolved,
         count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h
       FROM processing_errors`,
    );
    return { unresolved: Number(row.unresolved), last24h: Number(row.last24h) };
  }

  /** Зафиксировать прохождение этапа — показывается в карточке события. */
  async recordHistory(input: {
    entityType: string;
    entityId: string;
    stage: PipelineStage;
    status: string;
    message?: string | null;
    durationMs?: number | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO processing_history (entity_type, entity_id, stage, status, message, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        input.entityType,
        input.entityId,
        input.stage,
        input.status,
        input.message ?? null,
        input.durationMs ?? null,
      ],
    );
  }

  async historyFor(entityType: string, entityId: string) {
    const rows = await this.db.many(
      `SELECT stage, status, message, duration_ms, created_at
         FROM processing_history
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at`,
      [entityType, entityId],
    );
    return rows.map((row) => ({
      stage: String(row.stage),
      status: String(row.status),
      message: row.message ? String(row.message) : null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      createdAt: String(row.created_at),
    }));
  }

  // --- настройки ---------------------------------------------------------

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.maybeOne('SELECT value FROM settings WHERE key = $1', [key]);
    if (!row) return fallback;
    return row.value as T;
  }

  async getAllSettings(): Promise<Record<string, unknown>> {
    const rows = await this.db.many('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((row) => [String(row.key), row.value]));
  }

  async setSetting(
    key: string,
    value: unknown,
    options: { updatedBy?: string | null; isCritical?: boolean } = {},
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value, is_critical, updated_by)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), options.isCritical ?? false, options.updatedBy ?? null],
    );
  }
}
