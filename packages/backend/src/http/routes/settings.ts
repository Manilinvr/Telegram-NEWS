import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMPORTANCE_LEVELS } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { ProfanityGuard } from '../../modules/profanity/index.js';
import { AUDIT_ACTIONS, AuditRepository } from '../../repositories/audit.js';
import { CategoriesRepository } from '../../repositories/categories.js';
import { OpsRepository } from '../../repositories/ops.js';

/**
 * Настройки (ТЗ §32).
 *
 * Критичные разделы требуют повторного подтверждения паролем. Настройки
 * фильтра лексики можно РАСШИРИТЬ (добавить слова) и настроить политику по
 * грубой брани, но нельзя отключить проверку мата: такой настройки не
 * существует ни в API, ни в модели данных.
 */

const CRITICAL_KEYS = new Set(['publishing', 'security', 'profanity', 'dedup']);

const categorySchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'Только строчные латинские буквы, цифры и дефис'),
  title: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB'),
  emoji: z.string().min(1).max(8),
  defaultImportance: z.enum(IMPORTANCE_LEVELS as unknown as [string, ...string[]]),
  keywords: z.array(z.string().min(1).max(64)).max(100),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
});

const profanitySettingsSchema = z.object({
  /** Блокировать ли публикацию при грубой брани. Мат блокируется всегда. */
  blockOnWarn: z.boolean(),
  extraBlockWords: z.array(z.string().min(1).max(64)).max(500),
  extraAllowWords: z.array(z.string().min(1).max(64)).max(500),
});

export default async function settingsRoutes(
  app: FastifyInstance,
  options: { db: Database; config: AppConfig },
) {
  const { db, config } = options;
  const settings = new OpsRepository(db);
  const categories = new CategoriesRepository(db);
  const audit = new AuditRepository(db);

  app.get('/categories', { preHandler: app.requireAuth }, async (request) => {
    const parsed = z.object({ includeInactive: z.coerce.boolean().default(false) }).safeParse(request.query);
    return { categories: await categories.list(parsed.success ? parsed.data.includeInactive : false) };
  });

  app.put('/categories/:slug', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request, reply) => {
    const params = z.object({ slug: z.string().max(64) }).safeParse(request.params);
    const body = categorySchema.safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: body.success ? 'Некорректный slug.' : (body.error.issues[0]?.message ?? 'Некорректные данные.'),
      });
    }

    const category = await categories.upsert({ ...body.data, slug: params.data.slug } as never);
    await audit.log({
      userId: request.user!.id,
      action: AUDIT_ACTIONS.CATEGORY_UPDATED,
      entityType: 'category',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details: { slug: category.slug },
    });
    return category;
  });

  app.delete('/categories/:slug', { preHandler: app.requireRole(['OWNER']) }, async (request, reply) => {
    const parsed = z.object({ slug: z.string().max(64) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректный slug.' });
    }
    const removed = await categories.remove(parsed.data.slug);
    if (!removed) {
      return reply.code(400).send({
        error: 'CANNOT_DELETE',
        message: 'Категория не найдена или является системной и не может быть удалена.',
      });
    }
    return { ok: true };
  });

  app.get('/settings', { preHandler: app.requireAuth }, async () => {
    const stored = await settings.getAllSettings();
    return {
      settings: stored,
      // Значения из окружения показываем отдельно и без секретов:
      // владелец должен видеть фактическую конфигурацию.
      runtime: {
        aiProvider: config.AI_PROVIDER,
        aiModel: config.AI_MODEL,
        embeddingProvider: config.EMBEDDING_PROVIDER,
        transcriptionProvider: config.TRANSCRIPTION_PROVIDER,
        telegramIngestMode: config.TELEGRAM_INGEST_MODE,
        telegramPublishConfigured: Boolean(config.TELEGRAM_PUBLISH_BOT_TOKEN),
        telegramPublishChannel: config.TELEGRAM_PUBLISH_CHANNEL ?? null,
        telegramPublishDryRun: config.TELEGRAM_PUBLISH_DRY_RUN,
        vkConfigured: Boolean(config.VK_ACCESS_TOKEN),
        storageDriver: config.STORAGE_DRIVER,
        autoPublishEnabled: config.AUTO_PUBLISH_ENABLED,
        dedup: {
          timeWindowHours: config.DEDUP_TIME_WINDOW_HOURS,
          mergeThreshold: config.DEDUP_MERGE_THRESHOLD,
          reviewThreshold: config.DEDUP_REVIEW_THRESHOLD,
        },
      },
    };
  });

  /**
   * Изменение настроек.
   *
   * Критичные разделы требуют повторного ввода пароля (ТЗ §32): сессия
   * могла остаться открытой на чужом устройстве.
   */
  app.put('/settings/:key', { preHandler: app.requireRole(['OWNER', 'ADMIN']) }, async (request, reply) => {
    const params = z.object({ key: z.string().min(1).max(64) }).safeParse(request.params);
    const body = z
      .object({ value: z.unknown(), confirmPassword: z.string().max(200).optional() })
      .safeParse(request.body);

    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Некорректные данные.' });
    }

    const isCritical = CRITICAL_KEYS.has(params.data.key);

    if (isCritical) {
      if (!body.data.confirmPassword) {
        return reply.code(401).send({
          error: 'CONFIRMATION_REQUIRED',
          message: 'Изменение этой настройки требует повторного ввода пароля.',
        });
      }
      const check = await app.auth.login(request.user!.email, body.data.confirmPassword, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      if (!check.ok) {
        return reply.code(401).send({ error: 'CONFIRMATION_FAILED', message: 'Пароль указан неверно.' });
      }
    }

    // Настройки фильтра лексики проверяем отдельной схемой: сюда нельзя
    // передать произвольную структуру и тем более «выключатель».
    if (params.data.key === 'profanity') {
      const parsed = profanitySettingsSchema.safeParse(body.data.value);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Некорректные настройки фильтра.',
        });
      }
      await settings.setSetting(params.data.key, parsed.data, {
        updatedBy: request.user!.id,
        isCritical: true,
      });
    } else {
      await settings.setSetting(params.data.key, body.data.value, {
        updatedBy: request.user!.id,
        isCritical,
      });
    }

    await audit.log({
      userId: request.user!.id,
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      entityType: 'settings',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      details: { key: params.data.key, critical: isCritical },
    });

    return { ok: true, key: params.data.key };
  });

  /**
   * Проверка текста фильтром — инструмент настройки.
   * Позволяет убедиться, что слово блокируется или, наоборот, что
   * добавленное исключение сняло ложное срабатывание.
   */
  app.post('/settings/profanity/test', { preHandler: app.requireAuth }, async (request, reply) => {
    const body = z.object({ text: z.string().max(10_000) }).safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Передайте текст для проверки.' });
    }

    const stored = await settings.getSetting('profanity', {
      blockOnWarn: true,
      extraBlockWords: [],
      extraAllowWords: [],
    });
    const guard = new ProfanityGuard(stored as never);

    return guard.validateEditorialText(body.data.text);
  });
}
