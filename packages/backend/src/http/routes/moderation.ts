import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMPORTANCE_LEVELS, MODERATION_STATUSES } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { AiProcessor } from '../../modules/ai/processor.js';
import { ModerationService } from '../../modules/moderation/service.js';
import { DraftService } from '../../modules/pipeline/draft-service.js';
import { loadEditorialStyle } from '../../modules/ai/style.js';
import { buildTelegramPost } from '../../modules/pipeline/telegram-format.js';
import { PublishingService } from '../../modules/publishing/service.js';
import { ProfanityGuard } from '../../modules/profanity/index.js';
import type { StorageDriver } from '../../modules/storage/driver.js';
import { TranscriptionService } from '../../modules/transcription/service.js';
import { CategoriesRepository } from '../../repositories/categories.js';
import { DraftsRepository } from '../../repositories/drafts.js';
import { EventsRepository } from '../../repositories/events.js';
import { AUDIT_ACTIONS, AuditRepository } from '../../repositories/audit.js';
import { liveBus } from '../live.js';

const uuidParam = z.object({ id: z.string().uuid() });

const editDraftSchema = z.object({
  title: z.string().min(3).max(300),
  body: z.string().min(1).max(4000),
  telegramText: z.string().min(1).max(4096),
  categorySlug: z.string().max(64).optional(),
  importance: z.enum(IMPORTANCE_LEVELS as unknown as [string, ...string[]]).optional(),
  locationText: z.string().max(300).nullable().optional(),
  witnessQuotes: z.array(z.string().max(500)).max(10).optional(),
});

export default async function moderationRoutes(
  app: FastifyInstance,
  options: { db: Database; config: AppConfig; storage: StorageDriver },
) {
  const { db, config, storage } = options;

  const profanity = new ProfanityGuard();
  const moderation = new ModerationService(db, profanity);
  const publishing = new PublishingService(db, config, storage, undefined, profanity);
  const drafts = new DraftsRepository(db);
  const events = new EventsRepository(db);
  const categories = new CategoriesRepository(db);
  const transcription = new TranscriptionService(db, storage, config);
  const audit = new AuditRepository(db);

  const makeDraftService = async () => {
    const list = await categories.list();
    const ai = new AiProcessor(
      config,
      list.map((c) => ({
        slug: c.slug,
        title: c.title,
        keywords: c.keywords,
        defaultImportance: c.defaultImportance,
      })),
      profanity,
    );
    return new DraftService(db, ai, config, transcription, profanity);
  };

  /** Очередь модерации. */
  app.get('/moderation', { preHandler: app.requireAuth }, async (request) => {
    const query = z
      .object({
        status: z
          .union([z.string(), z.array(z.string())])
          .transform((v) => (Array.isArray(v) ? v : v.split(',')))
          .pipe(z.array(z.enum(MODERATION_STATUSES as unknown as [string, ...string[]])))
          .optional(),
      })
      .safeParse(request.query);

    const items = await moderation.list(
      query.success && query.data.status
        ? (query.data.status as Array<(typeof MODERATION_STATUSES)[number]>)
        : undefined,
    );
    return { items, counts: await moderation.counts() };
  });

  /** Взять материал в работу. */
  app.post('/moderation/:id/claim', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = uuidParam.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }
    const item = await moderation.claim(parsed.data.id, request.user!);
    if (!item) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Запись не найдена.' });
    liveBus.publish('moderation.updated', item);
    return item;
  });

  /**
   * Сохранить ручную правку черновика.
   *
   * Отредактированный текст проверяется заново (ТЗ §13.9): доверять
   * предыдущей проверке нельзя, содержимое изменилось.
   */
  app.patch(
    '/events/:id/draft',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const params = uuidParam.safeParse(request.params);
      const body = editDraftSchema.safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: 'VALIDATION_ERROR',
          message: body.success ? 'Некорректный идентификатор.' : (body.error.issues[0]?.message ?? 'Некорректные данные.'),
        });
      }

      const service = await makeDraftService();
      const result = await service.saveManualEdit({
        eventId: params.data.id,
        userId: request.user!.id,
        title: body.data.title,
        body: body.data.body,
        telegramText: body.data.telegramText,
        categorySlug: body.data.categorySlug ?? null,
        importance: body.data.importance as never,
        locationText: body.data.locationText ?? null,
        witnessQuotes: body.data.witnessQuotes ?? [],
      });

      await audit.log({
        userId: request.user!.id,
        action: AUDIT_ACTIONS.DRAFT_EDITED,
        entityType: 'event',
        entityId: params.data.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { version: result.draft.version, profanityPassed: result.allowed },
      });

      liveBus.publish('draft.created', { eventId: params.data.id, version: result.draft.version });

      // Правка сохраняется всегда, но при найденной лексике материал
      // блокируется — модератор видит причину и правит текст дальше.
      return reply.code(result.allowed ? 200 : 409).send({
        draft: result.draft,
        allowed: result.allowed,
        profanityReport: result.draft.profanityReport,
      });
    },
  );

  /** Перегенерировать черновик заново. */
  app.post(
    '/events/:id/draft/regenerate',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const parsed = uuidParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
      }

      const service = await makeDraftService();
      const draft = await service.generateForEvent(parsed.data.id);
      if (!draft) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Событие не найдено или без публикаций.' });
      }

      await audit.log({
        userId: request.user!.id,
        action: AUDIT_ACTIONS.DRAFT_REGENERATED,
        entityType: 'event',
        entityId: parsed.data.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { version: draft.version },
      });

      liveBus.publish('draft.created', { eventId: parsed.data.id, version: draft.version });
      return { draft };
    },
  );

  /** История версий черновика. */
  app.get('/events/:id/drafts', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = uuidParam.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }
    return { drafts: await drafts.history(parsed.data.id) };
  });

  /**
   * Предпросмотр Telegram-поста (ТЗ §12).
   *
   * Собирается ровно тем же кодом, что и текст при публикации, поэтому
   * предпросмотр не может разойтись с тем, что реально уйдёт в канал.
   */
  app.post('/events/:id/preview', { preHandler: app.requireAuth }, async (request, reply) => {
    const params = uuidParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }

    const body = z
      .object({
        title: z.string().max(300).optional(),
        body: z.string().max(4000).optional(),
        locationText: z.string().max(300).nullable().optional(),
        witnessQuotes: z.array(z.string().max(500)).max(10).optional(),
      })
      .safeParse(request.body ?? {});

    const event = await events.findById(params.data.id);
    if (!event) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Событие не найдено.' });

    const draft = await drafts.findCurrent(params.data.id);
    const sources = await events.sourcesFor(params.data.id);

    const title = body.success ? (body.data.title ?? draft?.title ?? event.title) : (draft?.title ?? event.title);
    const text = body.success ? (body.data.body ?? draft?.body ?? event.summary) : (draft?.body ?? event.summary);

    // Предпросмотр собирается с теми же настройками оформления, что и
    // публикация: иначе модератор утверждает не тот текст, который выйдет.
    const style = await loadEditorialStyle(db);

    const telegramText = buildTelegramPost({
      title,
      body: text,
      location: body.success ? (body.data.locationText ?? draft?.locationText ?? null) : draft?.locationText ?? null,
      eventTime: event.occurredAt,
      witnessQuotes: body.success ? (body.data.witnessQuotes ?? draft?.witnessQuotes ?? []) : draft?.witnessQuotes ?? [],
      sources: sources.map((s) => ({ title: s.sourceTitle, url: s.originalUrl })),
      hasMedia: false,
      useEmoji: style.useEmoji,
      signature: style.signature,
    });

    // Предпросмотр тоже проверяется: модератор должен сразу видеть, что
    // текст в текущем виде опубликовать не получится.
    const report = profanity.validateEditorialText({ title, body: text, telegramPreview: telegramText });

    return { telegramText, profanityReport: report, allowed: report.allowed };
  });

  app.post(
    '/moderation/:id/approve',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const parsed = uuidParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
      }

      const result = await moderation.approve({
        eventId: parsed.data.id,
        user: request.user!,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      if (!result.ok) {
        return reply.code(result.code === 'PROFANITY_BLOCKED' ? 409 : 404).send({
          error: result.code,
          message: result.message,
        });
      }

      liveBus.publish('moderation.updated', result.item);
      return result.item;
    },
  );

  app.post(
    '/moderation/:id/reject',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const params = uuidParam.safeParse(request.params);
      const body = z.object({ reason: z.string().min(1).max(1000) }).safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Укажите причину отклонения.' });
      }

      const result = await moderation.reject({
        eventId: params.data.id,
        user: request.user!,
        reason: body.data.reason,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      if (!result.ok) return reply.code(404).send({ error: 'NOT_FOUND', message: result.message });

      liveBus.publish('moderation.updated', result.item);
      return result.item;
    },
  );

  /** Вернуть отклонённый материал в очередь на проверку. */
  app.post(
    '/moderation/:id/restore',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const params = uuidParam.safeParse(request.params);
      if (!params.success) {
        return reply
          .code(400)
          .send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
      }

      const result = await moderation.restore({
        eventId: params.data.id,
        user: request.user!,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      if (!result.ok) return reply.code(409).send({ error: 'CONFLICT', message: result.message });

      liveBus.publish('moderation.updated', result.item);
      return result.item;
    },
  );

  /**
   * Публикация в Telegram.
   *
   * Все проверки выполняются в PublishingService на сервере. Даже при
   * прямом обращении к API в обход интерфейса материал без одобрения и
   * без прохождения проверки лексики опубликован не будет.
   */
  app.post(
    '/moderation/:id/publish',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const params = uuidParam.safeParse(request.params);
      const body = z.object({ confirmed: z.literal(true) }).safeParse(request.body);

      if (!params.success) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
      }
      if (!body.success) {
        return reply.code(400).send({
          error: 'NOT_CONFIRMED',
          message: 'Публикация требует явного подтверждения (confirmed: true).',
        });
      }

      const result = await publishing.publish({
        eventId: params.data.id,
        user: request.user!,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        confirmed: true,
      });

      if (!result.ok) {
        const status =
          result.code === 'FORBIDDEN' ? 403
          : result.code === 'NOT_FOUND' ? 404
          : result.code === 'PROFANITY_BLOCKED' ? 409
          : result.code === 'SEND_FAILED' ? 502
          : 400;
        return reply.code(status).send({
          error: result.code,
          message: result.message,
          ...(result.profanityReport ? { profanityReport: result.profanityReport } : {}),
        });
      }

      liveBus.publish('publication.created', result.publication);
      return result.publication;
    },
  );

  /** Состояние публикатора — показывается в настройках и диагностике. */
  app.get('/publishing/status', { preHandler: app.requireAuth }, async () => publishing.publisherStatus);
}
