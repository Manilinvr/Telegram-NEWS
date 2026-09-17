import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { AdapterRegistry } from '../../modules/ingestion/registry.js';
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
        configured: config.AI_PROVIDER === 'mock' || Boolean(config.ANTHROPIC_API_KEY),
      },
      jobs,
      errors,
      sources: Object.fromEntries(sourceHealth.map((row) => [String(row.health), Number(row.count)])),
      live: { clients: liveBus.clientCount },
      autoPublishEnabled: config.AUTO_PUBLISH_ENABLED,
    };
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
