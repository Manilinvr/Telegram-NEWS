import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { LocalStorageDriver, verifyMediaSignature, type StorageDriver } from '../../modules/storage/driver.js';
import { JOB_TYPES, JobQueue } from '../../queue/queue.js';
import { PIPELINE_STAGE } from '@nnm/shared';
import { logger } from '../../lib/logger.js';

/**
 * Отдача медиафайлов (ТЗ §22).
 *
 * Хранилище не публично. При локальном драйвере файлы отдаёт backend по
 * подписанной ссылке с ограниченным сроком действия; при S3 фронтенд
 * получает presigned URL и обращается к хранилищу напрямую.
 */
export default async function mediaRoutes(
  app: FastifyInstance,
  options: { storage: StorageDriver; config: AppConfig; db: Database },
) {
  const { storage, db } = options;
  const queue = new JobQueue(db);

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
      // Файл записан в базе, но исчез с диска.
      //
      // Так бывает на хостингах с недолговечной файловой системой: Render
      // на бесплатном тарифе выдаёт контейнеру чистый диск при каждой
      // пересборке, а ссылки на скачанные ранее файлы остаются в базе, и
      // вместо картинок в ленте появляются «битые» значки.
      //
      // Вместо того чтобы просто ответить 404, помечаем вложение к
      // повторному скачиванию: при следующем открытии ленты картинка уже
      // будет на месте, без ручного вмешательства.
      await requeueMissingMedia(db, queue, key);
      return reply.code(404).send({
        error: 'NOT_FOUND',
        message: 'Файл отсутствует на диске и поставлен в очередь на повторное скачивание.',
      });
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

/**
 * Пометить пропавший файл к повторному скачиванию.
 *
 * Исходный адрес вложения сохранён в базе, поэтому файл можно получить
 * заново. Ошибки здесь намеренно не поднимаются наверх: отдача файла —
 * не то место, где уместно падать из-за служебной операции.
 */
async function requeueMissingMedia(db: Database, queue: JobQueue, key: string): Promise<void> {
  try {
    const row = await db.maybeOne<{ id: string }>(
      `UPDATE media
          SET storage_key = NULL, thumbnail_key = NULL, download_status = 'NEW', download_error = NULL
        WHERE (storage_key = $1 OR thumbnail_key = $1)
          AND original_url IS NOT NULL
        RETURNING id`,
      [key],
    );
    if (!row) return;

    await queue.enqueue({
      type: JOB_TYPES.DOWNLOAD_MEDIA,
      stage: PIPELINE_STAGE.MEDIA_PROCESSING,
      payload: { mediaId: String(row.id) },
      dedupeKey: `media:${String(row.id)}`,
    });
    logger.info({ mediaId: row.id }, 'Файл пропал с диска — поставлен на повторное скачивание');
  } catch (error) {
    logger.warn({ err: error, key }, 'Не удалось поставить пропавший файл на повторное скачивание');
  }
}
