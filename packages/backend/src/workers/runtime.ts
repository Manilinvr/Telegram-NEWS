import { randomUUID } from 'node:crypto';
import { PIPELINE_STAGE } from '@nnm/shared';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/pool.js';
import { childLogger } from '../lib/logger.js';
import { JOB_TYPES, JobQueue } from '../queue/queue.js';
import { OpsRepository } from '../repositories/ops.js';
import { SourcesRepository } from '../repositories/sources.js';
import { createHandlers, type JobHandler } from './handlers.js';

const log = childLogger({ module: 'worker' });

/**
 * Исполнитель фоновых задач.
 *
 * Устройство цикла подчинено одному требованию: сбой отдельной задачи не
 * должен останавливать обработку (ТЗ §24). Любое исключение обработчика
 * перехватывается, фиксируется в журнале ошибок и переводит задачу на
 * повтор с возрастающей паузой, а воркер продолжает работу.
 */
export class Worker {
  private readonly id = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly queue: JobQueue;
  private readonly ops: OpsRepository;
  private readonly sources: SourcesRepository;
  private readonly handlers: Record<string, JobHandler>;

  private running = false;
  private activeJobs = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    const built = createHandlers(db, config);
    this.handlers = built.handlers;
    this.queue = built.queue;
    this.ops = new OpsRepository(db);
    this.sources = new SourcesRepository(db);
  }

  get workerId(): string {
    return this.id;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info({ workerId: this.id, concurrency: this.config.WORKER_CONCURRENCY }, 'Воркер запущен');

    // Планировщик опроса источников.
    this.timers.push(
      setInterval(() => {
        void this.scheduleSourceSyncs();
      }, 30_000),
    );

    // Периодическое обслуживание.
    this.timers.push(
      setInterval(() => {
        void this.queue.enqueue({
          type: JOB_TYPES.CLEANUP,
          dedupeKey: 'maintenance:cleanup',
          priority: 900,
        });
      }, 15 * 60_000),
    );

    // Первый проход сразу после старта, не дожидаясь таймера.
    void this.scheduleSourceSyncs();

    const loops: Promise<void>[] = [];
    for (let i = 0; i < this.config.WORKER_CONCURRENCY; i += 1) {
      loops.push(this.loop());
    }
    await Promise.all(loops);
  }

  async stop(): Promise<void> {
    log.info({ workerId: this.id }, 'Остановка воркера');
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];

    // Даём выполняющимся задачам завершиться, чтобы они не остались
    // в статусе RUNNING и не ждали восстановления по таймауту.
    const deadline = Date.now() + 30_000;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await sleep(200);
    }
  }

  /** Один рабочий поток: берёт задачи, пока воркер запущен. */
  private async loop(): Promise<void> {
    while (this.running) {
      let job;
      try {
        job = await this.queue.claim(this.id);
      } catch (error) {
        log.error({ err: error }, 'Не удалось получить задачу из очереди');
        await sleep(5_000);
        continue;
      }

      if (!job) {
        await sleep(this.config.WORKER_POLL_INTERVAL_MS);
        continue;
      }

      this.activeJobs += 1;
      const started = Date.now();

      try {
        const handler = this.handlers[job.type];
        if (!handler) {
          throw new Error(`Нет обработчика для задачи типа ${job.type}`);
        }

        const result = await handler(job.payload);
        await this.queue.complete(job.id, result);

        log.debug(
          { jobId: job.id, type: job.type, durationMs: Date.now() - started },
          'Задача выполнена',
        );
      } catch (error) {
        const message = (error as Error).message;
        const { willRetry, status } = await this.queue.fail(job.id, message);

        await this.ops.recordError({
          stage: (job.stage as never) ?? PIPELINE_STAGE.INGESTION,
          entityType: 'job',
          entityId: job.id,
          jobId: job.id,
          message,
          details: { type: job.type, attempts: job.attempts, willRetry, payload: job.payload },
        });

        log[willRetry ? 'warn' : 'error'](
          { jobId: job.id, type: job.type, attempts: job.attempts, status, err: message },
          willRetry ? 'Задача завершилась ошибкой, будет повторена' : 'Задача исчерпала попытки',
        );
      } finally {
        this.activeJobs -= 1;
      }
    }
  }

  /** Поставить в очередь опрос источников, которым подошло время. */
  private async scheduleSourceSyncs(): Promise<void> {
    try {
      const due = await this.sources.findDueForSync(100);
      for (const source of due) {
        await this.queue.enqueue({
          type: JOB_TYPES.SYNC_SOURCE,
          stage: PIPELINE_STAGE.INGESTION,
          payload: { sourceId: source.id },
          // Ключ дедупликации не даёт поставить второй опрос того же
          // источника, пока предыдущий ещё не завершён.
          dedupeKey: `sync:${source.id}`,
          priority: 50,
        });
      }
      if (due.length > 0) {
        log.debug({ count: due.length }, 'Запланирован опрос источников');
      }
    } catch (error) {
      log.error({ err: error }, 'Не удалось запланировать опрос источников');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
