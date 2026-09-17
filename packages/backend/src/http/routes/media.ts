import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { LocalStorageDriver, verifyMediaSignature, type StorageDriver } from '../../modules/storage/driver.js';

/**
 * Отдача медиафайлов (ТЗ §22).
 *
 * Хранилище не публично. При локальном драйвере файлы отдаёт backend по
 * подписанной ссылке с ограниченным сроком действия; при S3 фронтенд
 * получает presigned URL и обращается к хранилищу напрямую.
 */
export default async function mediaRoutes(
  app: FastifyInstance,
  options: { storage: StorageDriver; config: AppConfig },
) {
  const { storage } = options;

  app.get('/media/*', async (request, reply) => {
    if (!(storage instanceof LocalStorageDriver)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Маршрут доступен только для локального хранилища.' });
    }

    const key = decodeURIComponent((request.params as { '*': string })['*'] ?? '');
    const query = z
      .object({ exp: z.coerce.number().int(), sig: z.string().min(8).max(128) })
      .safeParse(request.query);

    if (!key || !query.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Некорректная ссылка на файл.' });
    }

    // Подпись подтверждает, что ссылку выдал backend и срок не истёк.
    // Без неё знание пути к файлу не даёт к нему доступа.
    if (!verifyMediaSignature(key, query.data.exp, query.data.sig)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Ссылка недействительна или истекла.' });
    }

    const filePath = await storage.localPath?.(key);
    if (!filePath) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Файл не найден.' });
    }

    reply.header('cache-control', 'private, max-age=300');
    reply.header('content-type', guessContentType(key));
    // Файл из хранилища никогда не должен исполняться браузером как документ.
    reply.header('content-disposition', 'inline');
    reply.header('x-content-type-options', 'nosniff');

    return reply.send(storage.createReadStream(key));
  });
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  return map[ext] ?? 'application/octet-stream';
}
