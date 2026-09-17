import type { FastifyInstance } from 'fastify';
import { feedFilterSchema } from '@nnm/shared';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import { EventDetailService } from '../../modules/feed/event-detail.js';
import { FeedQueryService } from '../../modules/feed/query.js';
import type { StorageDriver } from '../../modules/storage/driver.js';
import { EventsRepository } from '../../repositories/events.js';

const uuidParam = z.object({ id: z.string().uuid('Некорректный идентификатор') });

export default async function feedRoutes(
  app: FastifyInstance,
  options: { db: Database; storage: StorageDriver },
) {
  const { db, storage } = options;
  const feed = new FeedQueryService(db, storage);
  const details = new EventDetailService(db, storage);
  const events = new EventsRepository(db);

  /** Лента с полным набором фильтров (ТЗ §6). */
  app.get('/feed', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = feedFilterSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Некорректные параметры фильтра.',
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const result = await feed.list(parsed.data);
    return {
      items: result.items,
      total: result.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset ?? 0,
    };
  });

  /** Полная карточка события — один запрос, без дозагрузок (ТЗ §10). */
  app.get('/events/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = uuidParam.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }

    const detail = await details.get(parsed.data.id);
    if (!detail) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Событие не найдено.' });
    }
    return detail;
  });

  /** Отдельная публикация источника. */
  app.get('/posts/:id', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = uuidParam.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный идентификатор.' });
    }

    const post = await details.getPost(parsed.data.id);
    if (!post) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Публикация не найдена.' });
    }
    return post;
  });

  /**
   * Объединить два события вручную.
   *
   * Автоматика намеренно консервативна и иногда разводит то, что человек
   * видит как одно событие, — это действие исправляет такой случай.
   */
  app.post(
    '/events/:id/merge',
    { preHandler: app.requireRole(['OWNER', 'ADMIN']) },
    async (request, reply) => {
      const params = uuidParam.safeParse(request.params);
      const body = z.object({ targetEventId: z.string().uuid() }).safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректные данные.' });
      }
      if (params.data.id === body.data.targetEventId) {
        return reply
          .code(400)
          .send({ error: 'VALIDATION_ERROR', message: 'Событие нельзя объединить с самим собой.' });
      }

      const source = await events.findById(params.data.id);
      const target = await events.findById(body.data.targetEventId);
      if (!source || !target) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Событие не найдено.' });
      }

      // Публикации переносятся в целевое событие, исходное помечается
      // как слитое — история объединений сохраняется.
      const posts = await events.sourcesFor(source.id);
      for (const post of posts) {
        await events.attachPost({
          eventId: target.id,
          sourcePostId: post.sourcePostId,
          sourceId: post.sourceId,
          isIndependent: post.isIndependent,
          similarity: post.similarity,
          matchSignals: { mergedBy: 'HUMAN', fromEvent: source.id },
          attachedBy: 'HUMAN',
        });
      }
      await events.markMerged(source.id, target.id);
      await events.recalculateConfirmation(target.id);

      return { ok: true, mergedInto: target.id, movedPosts: posts.length };
    },
  );
}
