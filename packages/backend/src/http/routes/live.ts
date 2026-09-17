import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { liveBus } from '../live.js';

/**
 * Поток живых обновлений (ТЗ §15, §16).
 *
 * Доступен только аутентифицированному пользователю: через него уходят
 * заголовки новостей и статусы модерации.
 */
export default async function liveRoutes(app: FastifyInstance) {
  app.get('/live', { preHandler: app.requireAuth }, async (request, reply) => {
    const clientId = randomUUID();
    const disconnect = liveBus.subscribe(clientId, reply, request.user!.id);

    // Отписка при любом завершении соединения, включая обрыв сети.
    request.raw.on('close', disconnect);
    request.raw.on('error', disconnect);

    // Fastify не должен пытаться отправить тело: ответ ведётся вручную.
    return reply;
  });
}
