import type { JobStatus, PipelineStage } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapJob } from '../repositories/mappers.js';
import type { ProcessingJob } from '@nnm/shared';

/**
 * Очередь задач на PostgreSQL.
 *
 * Отдельный брокер (Redis/RabbitMQ) сознательно не вводится: задачи уже
 * обязаны храниться в БД по ТЗ (таблица processing_jobs), а `FOR UPDATE
 * SKIP LOCKED` даёт корректную конкурентную выдачу без гонок. Это убирает
 * из развёртывания целый сервис и исключает рассинхронизацию между
 * состоянием очереди и состоянием данных: постановка задачи и изменение
 * сущности могут выполняться в одной транзакции.
 */

/** Типы задач pipeline. */
export const JOB_TYPES = {
  SYNC_SOURCE: 'source.sync',
  PROCESS_POST: 'post.process',
  DOWNLOAD_MEDIA: 'media.download',
  TRANSCRIBE_MEDIA: 'media.transcribe',
  BUILD_EVENT: 'event.build',
  GENERATE_DRAFT: 'draft.generate',
  PUBLISH: 'publication.publish',
  /** Автоматическая публикация по правилам из настроек. */
  AUTO_PUBLISH: 'publication.auto',
  CLEANUP: 'maintenance.cleanup',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export interface EnqueueOptions {
  type: JobType | string;
  payload?: Record<string, unknown>;
  stage?: PipelineStage;
  /** Через сколько секунд задача станет доступной для выполнения. */
  delaySeconds?: number;
  /** Меньше — важнее. */
  priority?: number;
  maxAttempts?: number;
  /**
   * Ключ дедупликации: пока незавершённая задача с таким ключом существует,
   * повторная постановка не создаёт дубль.
   */
  dedupeKey?: string;
}

export class JobQueue {
  constructor(private readonly db: Database) {}

  /**
   * Поставить задачу.
   * Возвращает null, если задача с таким dedupeKey уже в работе.
   */
  async enqueue(options: EnqueueOptions, executor: Database = this.db): Promise<ProcessingJob | null> {
    const row = await executor.maybeOne(
      `INSERT INTO processing_jobs (type, stage, payload, run_at, priority, max_attempts, dedupe_key)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::int), $5, $6, $7)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING')
       DO NOTHING
       RETURNING *`,
      [
        options.type,
        options.stage ?? null,
        JSON.stringify(options.payload ?? {}),
        options.delaySeconds ?? 0,
        options.priority ?? 100,
        options.maxAttempts ?? 5,
        options.dedupeKey ?? null,
      ],
    );
    return row ? mapJob(row) : null;
  }

  /**
   * Взять следующую задачу в работу.
   *
   * `FOR UPDATE SKIP LOCKED` гарантирует, что одну и ту же задачу не
   * получат два воркера одновременно: заблокированные строки просто
   * пропускаются, вместо того чтобы выстраивать воркеров в очередь.
   */
  async claim(workerId: string, types?: string[]): Promise<ProcessingJob | null> {
    const row = await this.db.maybeOne(
      `UPDATE processing_jobs SET
         status     = 'RUNNING',
         attempts   = attempts + 1,
         locked_by  = $1,
         locked_at  = now(),
         started_at = COALESCE(started_at, now())
       WHERE id = (
         SELECT id FROM processing_jobs
          WHERE status = 'QUEUED'
            AND run_at <= now()
            AND ($2::text[] IS NULL OR type = ANY($2))
          ORDER BY priority, run_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING *`,
      [workerId, types ?? null],
    );
    return row ? mapJob(row) : null;
  }

  async complete(jobId: string, result?: unknown): Promise<void> {
    await this.db.query(
      `UPDATE processing_jobs SET
         status = 'COMPLETED', finished_at = now(), locked_by = NULL, locked_at = NULL,
         result = $2::jsonb, last_error = NULL
       WHERE id = $1`,
      [jobId, result === undefined ? null : JSON.stringify(result)],
    );
  }

  /**
   * Отметить сбой.
   *
   * Пока попытки не исчерпаны, задача возвращается в очередь с
   * экспоненциальной задержкой; после исчерпания переходит в DEAD и
   * остаётся видимой в диагностике, а не исчезает молча.
   */
  async fail(jobId: string, error: string): Promise<{ willRetry: boolean; status: JobStatus }> {
    const row = await this.db.one(
      `UPDATE processing_jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
         -- Экспоненциальная задержка: 4с, 8с, 16с, 32с… но не дольше 10 минут.
         run_at = now() + make_interval(secs => LEAST(600, power(2, attempts + 1)::int)),
         locked_by = NULL,
         locked_at = NULL,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
         last_error = $2
       WHERE id = $1
       RETURNING status`,
      [jobId, error.slice(0, 4000)],
    );
    const status = String(row.status) as JobStatus;
    return { willRetry: status === 'QUEUED', status };
  }

  /**
   * Вернуть в очередь задачи, «зависшие» на умершем воркере.
   *
   * Если процесс воркера погиб, не сняв блокировку, задача осталась бы в
   * RUNNING навсегда. Периодический вызов возвращает такие задачи в работу.
   */
  async recoverStale(olderThanMinutes = 15): Promise<number> {
    const result = await this.db.query(
      `UPDATE processing_jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
         locked_by = NULL,
         locked_at = NULL,
         last_error = COALESCE(last_error, 'Воркер не завершил задачу: блокировка просрочена')
       WHERE status = 'RUNNING'
         AND locked_at < now() - make_interval(mins => $1::int)`,
      [olderThanMinutes],
    );
    return result.rowCount ?? 0;
  }

  async counts(): Promise<{ queued: number; running: number; failed: number }> {
    const row = await this.db.one(
      `SELECT
         count(*) FILTER (WHERE status = 'QUEUED')::int  AS queued,
         count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
         count(*) FILTER (WHERE status IN ('FAILED','DEAD'))::int AS failed
       FROM processing_jobs`,
    );
    return {
      queued: Number(row.queued),
      running: Number(row.running),
      failed: Number(row.failed),
    };
  }

  async listRecent(limit = 50): Promise<ProcessingJob[]> {
    const rows = await this.db.many(
      'SELECT * FROM processing_jobs ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(mapJob);
  }

  /** Удалить старые завершённые задачи, чтобы таблица не росла бесконечно. */
  async purgeCompleted(olderThanDays = 7): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM processing_jobs
        WHERE status = 'COMPLETED'
          AND finished_at < now() - make_interval(days => $1::int)`,
      [olderThanDays],
    );
    return result.rowCount ?? 0;
  }
}
