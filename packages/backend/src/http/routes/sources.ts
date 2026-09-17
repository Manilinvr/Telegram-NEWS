import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { AdapterRegistry } from '../../modules/ingestion/registry.js';
import { JOB_TYPES, JobQueue } from '../../queue/queue.js';
import { AUDIT_ACTIONS, AuditRepository } from '../../repositories/audit.js';
import { SourcesRepository } from '../../repositories/sources.js';
import { liveBus } from '../live.js';

const sourceSchema = z.object({
  type: z.enum(['TELEGRAM', 'VK']),
  title: z.string().min(1).max(200),
  username: z.string().max(200).nullable().optional(),
  externalId: z.string().max(100).nullable().optional(),
  url: z.string().url('Некорректный URL').max(500),
  pollIntervalSeconds: z.number().int().min(15).max(86_400).optional(),
  config: z
    .object({
      fetchLimit: z.number().int().min(1).max(100).optional(),
      backfillHours: z.number().int().min(0).max(720).optional(),
      skipForwards: z.boolean().optional(),
      downloadMedia: z.boolean().optional(),
      minTextLength: z.number().int().min(0).max(5000).optional(),
    })
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export default async function sourceRoutes(
  app: FastifyInstance,
  options: { db: Database; config: AppConfig },
) {
  const { db, config } = options;
  const sources = new SourcesRepository(db);
  const audit = new AuditRepository(db);
  const queue = new JobQueue(db);
  const registry = new AdapterRegistry(config);

  app.get('/sources', { preHandler: app.requireAuth }, async () => ({
    sources: await sources.list(),
    adapters: registry.status(),
  }));

  app.get('/sources/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }
    const source = await sources.findById(parsed.data.id);
    if (!source) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Источник не найден.' });

    // Последние ошибки именно этого источника — для диагностики.
    const errors = await db.many(
      `SELECT stage, message, created_at FROM processing_errors
        WHERE source_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [parsed.data.id],
    );
    return { source, errors };
  });

  app.post('/sources', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request, reply) => {
    const parsed = sourceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Некорректные данные источника.',
      });
    }

    // Проверяем доступность источника ДО сохранения: иначе в списке
    // появится канал, который никогда не отдаст ни одной публикации.
    const adapter = registry.get(parsed.data.type);
    if (!adapter) {
      return reply.code(400).send({
        error: 'ADAPTER_UNAVAILABLE',
        message: `Источники типа ${parsed.data.type} не настроены.`,
      });
    }

    const verification = await adapter.verify({
      type: parsed.data.type,
      username: parsed.data.username ?? null,
      externalId: parsed.data.externalId ?? null,
      url: parsed.data.url,
    });

    if (!verification.ok) {
      return reply.code(400).send({ error: 'SOURCE_UNREACHABLE', message: verification.reason });
    }

    try {
      const source = await sources.create({
        ...parsed.data,
        title: parsed.data.title || verification.title || parsed.data.url,
        externalId: parsed.data.externalId ?? verification.externalId ?? null,
      });

      await audit.log({
        userId: request.user!.id,
        action: AUDIT_ACTIONS.SOURCE_CREATED,
        entityType: 'source',
        entityId: source.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { title: source.title, type: source.type },
      });

      // Первый опрос сразу, не дожидаясь планировщика.
      await queue.enqueue({
        type: JOB_TYPES.SYNC_SOURCE,
        payload: { sourceId: source.id },
        dedupeKey: `sync:${source.id}`,
        priority: 10,
      });

      return reply.code(201).send(source);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'DUPLICATE', message: 'Такой источник уже добавлен.' });
      }
      throw error;
    }
  });

  app.patch('/sources/:id', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = sourceSchema.partial().extend({ isActive: z.boolean().optional() }).safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректные данные.' });
    }

    const source = await sources.update(params.data.id, body.data as never);
    if (!source) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Источник не найден.' });

    await audit.log({
      userId: request.user!.id,
      action: AUDIT_ACTIONS.SOURCE_UPDATED,
      entityType: 'source',
      entityId: source.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details: body.data,
    });

    liveBus.publish('source.health', { sourceId: source.id, health: source.health });
    return source;
  });

  app.delete('/sources/:id', { preHandler: app.requireRole(['OWNER']) }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }

    const removed = await sources.remove(parsed.data.id);
    if (!removed) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Источник не найден.' });

    await audit.log({
      userId: request.user!.id,
      action: AUDIT_ACTIONS.SOURCE_DELETED,
      entityType: 'source',
      entityId: parsed.data.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    return { ok: true };
  });

  /** Опросить источник немедленно. */
  app.post('/sources/:id/sync', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }

    const source = await sources.findById(parsed.data.id);
    if (!source) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Источник не найден.' });

    const job = await queue.enqueue({
      type: JOB_TYPES.SYNC_SOURCE,
      payload: { sourceId: source.id },
      dedupeKey: `sync:${source.id}`,
      priority: 10,
    });

    return {
      queued: job !== null,
      message: job ? 'Опрос поставлен в очередь.' : 'Опрос этого источника уже выполняется.',
    };
  });
}
