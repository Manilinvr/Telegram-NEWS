import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { AiProcessor } from '../../modules/ai/processor.js';
import { AdapterRegistry } from '../../modules/ingestion/registry.js';
import { loadPublishingSettings } from '../../modules/publishing/settings.js';
import { TelegramPublisher } from '../../modules/publishing/telegram-publisher.js';
import { createTranscriptionProvider } from '../../modules/transcription/provider.js';
import { JobQueue } from '../../queue/queue.js';
import { AuditRepository } from '../../repositories/audit.js';
import { OpsRepository } from '../../repositories/ops.js';
import { liveBus } from '../live.js';

/**
 * Раздел диагностики (ТЗ §23).
 *
 * Показывает фактическое состояние всех подсистем, а не то, что записано
 * в конфигурации: настроенный провайдер может быть недоступен, и это
 * должно быть видно сразу.
 */
export default async function diagnosticsRoutes(
  app: FastifyInstance,
  options: { db: Database; config: AppConfig },
) {
  const { db, config } = options;
  const ops = new OpsRepository(db);
  const queue = new JobQueue(db);
  const audit = new AuditRepository(db);

  /** Проверка живости — не требует авторизации, используется мониторингом. */
  app.get('/health', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: 'degraded', message: 'База данных недоступна.' });
    }
  });

  app.get('/diagnostics', { preHandler: app.requireAuth }, async () => {
    const registry = new AdapterRegistry(config);
    const publisher = new TelegramPublisher(config);
    const transcription = createTranscriptionProvider(config);
    const capabilities = await db.capabilities();

    const aiReason = new AiProcessor(config, []).unavailableReason();
    const { autoPublish } = await loadPublishingSettings(db);

    const [jobs, errors, sourceHealth] = await Promise.all([
      queue.counts(),
      ops.errorCounts(),
      db.many(
        `SELECT health, count(*)::int AS count FROM sources GROUP BY health`,
      ),
    ]);

    return {
      database: {
        version: capabilities.serverVersion,
        pgvector: capabilities.hasPgVector,
        pgTrgm: capabilities.hasPgTrgm,
        unaccent: capabilities.hasUnaccent,
      },
      adapters: registry.status(),
      publishing: {
        configured: publisher.isConfigured(),
        reason: publisher.unavailableReason(),
        channel: publisher.channel,
        dryRun: publisher.isDryRun,
      },
      transcription: {
        provider: transcription.name,
        available: transcription.isAvailable(),
        reason: transcription.unavailableReason(),
      },
      ai: {
        provider: config.AI_PROVIDER,
        model: config.AI_MODEL,
        // Настроенность спрашивается у самого процессора: раньше здесь
        // проверялся только ключ Anthropic, и подключённая служба с
        // интерфейсом OpenAI (DeepSeek, локальная модель) показывалась
        // ненастроенной — по диагностике нельзя было понять, работает
        // модель или разбор идёт по правилам.
        configured: aiReason === null,
        reason: aiReason,
      },
      jobs,
      errors,
      sources: Object.fromEntries(sourceHealth.map((row) => [String(row.health), Number(row.count)])),
      live: { clients: liveBus.clientCount },
      autoPublishEnabled: autoPublish,
    };
  });

  /**
   * Живая проверка модели.
   *
   * Отдельным действием, а не при каждом открытии диагностики: это
   * настоящий запрос к внешней службе, и делать его на каждый показ
   * страницы означало бы тратить платный лимит впустую.
   */
  app.post('/diagnostics/ai-check', { preHandler: app.requireAuth }, async () => {
    const result = await new AiProcessor(config, []).check();
    return { ...result, configuredProvider: config.AI_PROVIDER };
  });

  app.get('/diagnostics/errors', { preHandler: app.requireAuth }, async (request) => {
    const parsed = z
      .object({
        unresolvedOnly: z.coerce.boolean().default(true),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .safeParse(request.query);
    const opts = parsed.success ? parsed.data : { unresolvedOnly: true, limit: 100 };
    return { errors: await ops.listErrors(opts) };
  });

  app.post('/diagnostics/errors/:id/resolve', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }
    await ops.resolveError(parsed.data.id);
    return { ok: true };
  });

  /**
   * Закрыть разом все ошибки — или только повторы одной и той же.
   *
   * После исправления причины в журнале остаются сотни одинаковых записей
   * от прежней версии; на их фоне не видно новую ошибку. Записи при этом
   * не удаляются, а помечаются разобранными.
   */
  app.post(
    '/diagnostics/errors/resolve-all',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request) => {
      const parsed = z
        .object({ stage: z.string().max(64).optional(), message: z.string().max(2000).optional() })
        .safeParse(request.body ?? {});
      const resolved = await ops.resolveAllErrors(parsed.success ? parsed.data : {});
      return { ok: true, resolved };
    },
  );

  app.get('/diagnostics/jobs', { preHandler: app.requireAuth }, async (request) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(request.query);
    return {
      jobs: await queue.listRecent(parsed.success ? parsed.data.limit : 50),
      counts: await queue.counts(),
    };
  });

  /** Журнал административных действий. */
  app.get('/audit', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        action: z.string().max(100).optional(),
      })
      .safeParse(request.query);
    return { entries: await audit.list(parsed.success ? parsed.data : { limit: 100 }) };
  });
}
