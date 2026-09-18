import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import type { Database } from '../../src/db/pool.js';
import { AiProcessor } from '../../src/modules/ai/processor.js';
import { createEmbeddingProvider } from '../../src/modules/dedup/embeddings.js';
import { EmbeddingRepository } from '../../src/modules/dedup/repository.js';
import { AdapterRegistry } from '../../src/modules/ingestion/registry.js';
import { IngestionService } from '../../src/modules/ingestion/service.js';
import { ModerationService } from '../../src/modules/moderation/service.js';
import { ModerationRepository } from '../../src/repositories/moderation.js';
import { DraftService } from '../../src/modules/pipeline/draft-service.js';
import { EventBuilder } from '../../src/modules/pipeline/event-builder.js';
import { PublishingService } from '../../src/modules/publishing/service.js';
import { createStorageDriver } from '../../src/modules/storage/driver.js';
import { TranscriptionService } from '../../src/modules/transcription/service.js';
import { CategoriesRepository } from '../../src/repositories/categories.js';
import { DraftsRepository } from '../../src/repositories/drafts.js';
import { EventsRepository } from '../../src/repositories/events.js';
import { ModerationRepository } from '../../src/repositories/moderation.js';
import { OpsRepository } from '../../src/repositories/ops.js';
import { createHandlers } from '../../src/workers/handlers.js';
import { JOB_TYPES } from '../../src/queue/queue.js';
import { AiUnavailableError, type AiProvider } from '../../src/modules/ai/provider.js';
import {
  MODEL_SCHEMA_ERROR,
  MODEL_UNAVAILABLE_ERROR,
} from '../../src/modules/pipeline/draft-service.js';
import { SourcesRepository } from '../../src/repositories/sources.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { closeTestDb, getTestDb, resetDb } from '../helpers/db.js';
import { MockSourceAdapter, makePost } from '../helpers/mock-adapter.js';
import type { User } from '@nnm/shared';

/**
 * Сквозной тест конвейера — критерии готовности MVP (ТЗ §35).
 *
 * Проверяется весь путь: получение публикации → объединение в событие →
 * черновик → обязательная проверка лексики → ручная модерация →
 * публикация. Особое внимание — барьерам, которые не должны пропускать
 * материал без подтверждения человека и без проверки текста.
 */

let db: Database;
let config: AppConfig;
let adapter: MockSourceAdapter;
let ingestion: IngestionService;
let builder: EventBuilder;
let draftService: DraftService;
let moderation: ModerationService;
let publishing: PublishingService;
let owner: User;
let sourceId: string;

const events = () => new EventsRepository(db);
const drafts = () => new DraftsRepository(db);

beforeAll(async () => {
  db = await getTestDb();
  config = loadConfig({ ...process.env, TRANSCRIPTION_PROVIDER: 'mock' });
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetDb(db);

  const categories = new CategoriesRepository(db);
  await categories.seedDefaults();
  const list = await categories.list();

  const users = new UsersRepository(db);
  owner = await users.create({
    email: 'owner@example.com',
    passwordHash: await hashPassword('test-owner-password-2026'),
    displayName: 'Владелец',
    role: 'OWNER',
  });

  adapter = new MockSourceAdapter();
  const registry = new AdapterRegistry(config);
  registry.register('TELEGRAM', adapter);

  ingestion = new IngestionService(db, registry, config);

  const ai = new AiProcessor(
    config,
    list.map((c) => ({
      slug: c.slug,
      title: c.title,
      keywords: c.keywords,
      defaultImportance: c.defaultImportance,
    })),
  );

  const storage = createStorageDriver(config);
  const embeddings = new EmbeddingRepository(db, createEmbeddingProvider(config));
  const transcription = new TranscriptionService(db, storage, config);

  builder = new EventBuilder(db, ai, embeddings, config);
  draftService = new DraftService(db, ai, config, transcription);
  moderation = new ModerationService(db);
  publishing = new PublishingService(db, config, storage);

  const sources = new SourcesRepository(db);
  const source = await sources.create({
    type: 'TELEGRAM',
    title: 'ТГ Новороссийск',
    username: 'test_channel',
    url: 'https://t.me/test_channel',
  });
  sourceId = source.id;
});

/** Получить публикации и обработать их до стадии события. */
async function ingestAndProcess(): Promise<string[]> {
  const sources = new SourcesRepository(db);
  const source = await sources.findById(sourceId);
  await ingestion.syncSource(source!);

  const posts = await db.many('SELECT id FROM source_posts ORDER BY posted_at');
  const eventIds: string[] = [];

  for (const post of posts) {
    const outcome = await builder.processPost(String(post.id));
    if (outcome.eventId) eventIds.push(outcome.eventId);
  }
  return [...new Set(eventIds)];
}

describe('Сбор публикаций', () => {
  it('сохраняет публикацию с исходным текстом и ссылкой на оригинал', async () => {
    adapter.setPosts([
      makePost({
        id: '1001',
        text: 'В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей.',
      }),
    ]);

    const sources = new SourcesRepository(db);
    const result = await ingestion.syncSource((await sources.findById(sourceId))!);

    expect(result.saved).toBe(1);

    const post = await db.one('SELECT * FROM source_posts LIMIT 1');
    expect(String(post.raw_text)).toContain('улице Видова');
    expect(String(post.url)).toBe('https://t.me/test_channel/1001');
    expect(post.status).toBe('NEW');
  });

  it('повторный опрос не создаёт дублей', async () => {
    const posts = [makePost({ id: '1001', text: 'Текст публикации о городском событии.' })];
    const sources = new SourcesRepository(db);

    adapter.setPosts(posts);
    await ingestion.syncSource((await sources.findById(sourceId))!);
    adapter.setPosts(posts);
    await ingestion.syncSource((await sources.findById(sourceId))!);

    const count = await db.one('SELECT count(*)::int AS count FROM source_posts');
    expect(Number(count.count)).toBe(1);
  });

  it('сбой источника фиксируется и не выбрасывает исключение', async () => {
    adapter.failWith(new Error('Источник недоступен'));
    const sources = new SourcesRepository(db);

    const result = await ingestion.syncSource((await sources.findById(sourceId))!);

    expect(result.error).toContain('недоступен');

    // Источник помечен как деградировавший, но не отключён.
    const source = await sources.findById(sourceId);
    expect(source?.health).toBe('DEGRADED');
    expect(source?.isActive).toBe(true);

    // Ошибка записана в журнал для диагностики.
    const errors = await db.many(`SELECT * FROM processing_errors WHERE source_id = $1`, [sourceId]);
    expect(errors.length).toBe(1);
  });

  it('сохраняет исходный мат, но помечает публикацию', async () => {
    adapter.setPosts([
      makePost({ id: '1002', text: `Очевидец кричал: ${['б','л','я','д','ь'].join('')}! На дороге авария.` }),
    ]);
    const sources = new SourcesRepository(db);
    await ingestion.syncSource((await sources.findById(sourceId))!);

    const post = await db.one('SELECT raw_text, raw_has_profanity FROM source_posts LIMIT 1');
    // Исходные данные не изменяются — они нужны для аудита.
    expect(String(post.raw_text)).toContain('авария');
    expect(post.raw_has_profanity).toBe(true);
  });
});

describe('Объединение публикаций в события', () => {
  it('две публикации об одном ДТП дают одно событие', async () => {
    adapter.setPosts([
      makePost({
        id: '2001',
        minutesAgo: 60,
        text: 'В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей. На месте работают сотрудники ДПС, движение затруднено.',
      }),
      makePost({
        id: '2002',
        minutesAgo: 35,
        text: 'ДТП на улице Видова в Новороссийске: столкнулись две машины. Полиция на месте, движение по полосе затруднено.',
      }),
    ]);

    const eventIds = await ingestAndProcess();

    expect(eventIds).toHaveLength(1);

    const event = await events().findById(eventIds[0]!);
    expect(event?.sourcePostCount).toBe(2);
  });

  it('разные происшествия остаются разными событиями', async () => {
    adapter.setPosts([
      makePost({
        id: '2003',
        minutesAgo: 90,
        text: 'В Новороссийске на улице Видова произошло ДТП, столкнулись два автомобиля.',
      }),
      makePost({
        id: '2004',
        minutesAgo: 20,
        text: 'В городском парке Новороссийска открыли новую детскую площадку для жителей.',
      }),
    ]);

    const eventIds = await ingestAndProcess();
    expect(eventIds.length).toBe(2);
  });

  it('сохраняет происхождение каждой публикации события', async () => {
    adapter.setPosts([
      makePost({ id: '2005', minutesAgo: 30, text: 'Пожар в жилом доме на Анапском шоссе, работают пожарные расчёты.' }),
    ]);

    const [eventId] = await ingestAndProcess();
    const sources = await events().sourcesFor(eventId!);

    expect(sources).toHaveLength(1);
    expect(sources[0]!.sourceTitle).toBe('ТГ Новороссийск');
    // Оригинальная ссылка обязана сохраняться.
    expect(sources[0]!.originalUrl).toContain('t.me/test_channel');
  });
});

describe('Черновик и обязательная проверка лексики', () => {
  it('создаёт черновик и ставит событие в очередь модерации', async () => {
    adapter.setPosts([
      makePost({
        id: '3001',
        text: 'В Восточном районе Новороссийска временно отключили электричество из-за аварии на сетях. Работы продлятся до вечера.',
      }),
    ]);

    const [eventId] = await ingestAndProcess();
    const draft = await draftService.generateForEvent(eventId!);

    expect(draft).not.toBeNull();
    expect(draft!.telegramText.length).toBeGreaterThan(10);
    // Проверка лексики выполнена и зафиксирована в самом черновике.
    expect(draft!.profanityChecked).toBe(true);
    expect(draft!.profanityPassed).toBe(true);

    const queue = await new ModerationRepository(db).findByEvent(eventId!);
    expect(queue?.status).toBe('PENDING');
  });

  it('текст поста содержит указание источника', async () => {
    adapter.setPosts([
      makePost({ id: '3002', text: 'На набережной Новороссийска пройдёт фестиваль уличной культуры в субботу.' }),
    ]);

    const [eventId] = await ingestAndProcess();
    const draft = await draftService.generateForEvent(eventId!);

    // Система не выдаёт переработанный чужой материал за свой.
    expect(draft!.telegramText).toContain('Источник:');
    expect(draft!.telegramText).toContain('ТГ Новороссийск');
  });

  it('мат из источника не попадает в черновик', async () => {
    const mat = ['б', 'л', 'я', 'д', 'ь'].join('');
    adapter.setPosts([
      makePost({
        id: '3003',
        text: `Водитель кричал ${mat} и уехал. В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей.`,
      }),
    ]);

    const [eventId] = await ingestAndProcess();
    const draft = await draftService.generateForEvent(eventId!);

    expect(draft).not.toBeNull();
    // Готовый текст не содержит запрещённой лексики...
    expect(draft!.telegramText.toLowerCase()).not.toContain(mat);
    expect(draft!.title.toLowerCase()).not.toContain(mat);
    // ...при этом исходная публикация сохранена без изменений.
    const post = await db.one('SELECT raw_text FROM source_posts LIMIT 1');
    expect(String(post.raw_text)).toContain(mat);
  });
});

describe('Работа без модели', () => {
  /** Провайдер, который настроен, но всегда отказывает — как при исчерпанном лимите. */
  const brokenProvider: AiProvider = {
    name: 'broken',
    model: 'test-model',
    isAvailable: () => true,
    complete: async () => {
      throw new AiUnavailableError('Исчерпан лимит запросов к службе модели (50 в сутки).');
    },
  };

  async function prepareEvent(id: string): Promise<string> {
    adapter.setPosts([
      makePost({
        id,
        text: 'В Новороссийске на улице Советов упало дерево, движение затруднено.',
      }),
    ]);
    const [eventId] = await ingestAndProcess();
    return eventId!;
  }

  it('черновик, собранный правилами, не выдаётся за написанный человеком', async () => {
    const eventId = await prepareEvent('6001');
    await draftService.generateForEvent(eventId);

    const draft = await drafts().findCurrent(eventId);

    // Раньше здесь стояло HUMAN, и такой черновик было не отличить от
    // правки редактора — а значит, нельзя было безопасно пересобрать.
    expect(draft?.createdBy).toBe('RULES');
    expect(draft?.model).toBeNull();
  });

  it('в журнале различаются «не ответила» и «ответила не по формату»', async () => {
    const categories = await new CategoriesRepository(db).list();
    // Служба отвечает, но текстом, который не разбирается как нужный JSON.
    const wrongFormat: AiProvider = {
      name: 'wrong-format',
      model: 'test-model',
      isAvailable: () => true,
      complete: async () => 'Конечно! Вот новость: во дворе упало дерево.',
    };

    const storage = createStorageDriver(config);
    const service = new DraftService(
      db,
      new AiProcessor(
        config,
        categories.map((c) => ({
          slug: c.slug,
          title: c.title,
          keywords: c.keywords,
          defaultImportance: c.defaultImportance,
        })),
        undefined,
        wrongFormat,
      ),
      config,
      new TranscriptionService(db, storage, config),
    );

    const eventId = await prepareEvent('6006');
    await service.generateForEvent(eventId);

    const errors = await new OpsRepository(db).listErrors({ unresolvedOnly: true, limit: 50 });
    const schemaError = errors.find((error) => error.message === MODEL_SCHEMA_ERROR);

    // Разные неполадки лечатся по-разному: ключ и лимит здесь ни при чём,
    // помогает более способная модель.
    expect(schemaError).toBeDefined();
    expect(errors.some((error) => error.message === MODEL_UNAVAILABLE_ERROR)).toBe(false);
    expect(String(schemaError?.details.kind)).toBe('schema');
    expect(String(schemaError?.details.reason)).toMatch(/JSON|схем/i);
  });

  it('недоступность модели попадает в журнал ошибок, но не по записи на публикацию', async () => {
    const categories = await new CategoriesRepository(db).list();
    const failing = new AiProcessor(
      config,
      categories.map((c) => ({
        slug: c.slug,
        title: c.title,
        keywords: c.keywords,
        defaultImportance: c.defaultImportance,
      })),
      undefined,
      brokenProvider,
    );
    const storage = createStorageDriver(config);
    const service = new DraftService(
      db,
      failing,
      config,
      new TranscriptionService(db, storage, config),
    );

    const first = await prepareEvent('6002');
    await service.generateForEvent(first);
    const second = await prepareEvent('6003');
    await service.generateForEvent(second);

    const errors = await new OpsRepository(db).listErrors({ unresolvedOnly: true, limit: 50 });
    const modelErrors = errors.filter((error) => error.message === MODEL_UNAVAILABLE_ERROR);

    // Сбой повторяется на каждой публикации, но запись нужна одна:
    // сотня одинаковых строк скрыла бы все остальные ошибки.
    expect(modelErrors).toHaveLength(1);
    expect(String(modelErrors[0]?.details.reason)).toMatch(/лимит/i);
    expect(String(modelErrors[0]?.details.kind)).toBe('unavailable');

    // Материал при этом не потерян — черновик собран правилами.
    expect((await drafts().findCurrent(first))?.createdBy).toBe('RULES');
  });

  it('обслуживание возвращает модели материалы, разобранные правилами', async () => {
    const eventId = await prepareEvent('6004');
    await draftService.generateForEvent(eventId);
    expect((await drafts().findCurrent(eventId))?.createdBy).toBe('RULES');

    // Конфигурация с подключённой службой: обслуживание должно увидеть,
    // что модель снова есть, и вернуть материал в работу.
    const withModel = loadConfig({
      ...process.env,
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://127.0.0.1:4799/v1',
      AI_MODEL: 'test-model',
      TRANSCRIPTION_PROVIDER: 'mock',
    });
    const { handlers } = createHandlers(db, withModel);
    const result = (await handlers[JOB_TYPES.CLEANUP]!({})) as { redrafted: number };

    expect(result.redrafted).toBe(1);

    const job = await db.maybeOne(
      `SELECT payload FROM processing_jobs
        WHERE type = $1 AND status = 'QUEUED'
        ORDER BY created_at DESC LIMIT 1`,
      [JOB_TYPES.GENERATE_DRAFT],
    );
    expect(String((job?.payload as { eventId?: string })?.eventId)).toBe(eventId);
  });

  it('пока модель не отвечает, обслуживание не дёргает её впустую', async () => {
    const eventId = await prepareEvent('6005');
    await draftService.generateForEvent(eventId);

    // Недоступность записана только что — попытка откладывается.
    await new OpsRepository(db).recordError({
      stage: 'AI_DRAFT',
      entityType: 'event',
      entityId: eventId,
      message: MODEL_UNAVAILABLE_ERROR,
    });

    const withModel = loadConfig({
      ...process.env,
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://127.0.0.1:4799/v1',
      AI_MODEL: 'test-model',
      TRANSCRIPTION_PROVIDER: 'mock',
    });
    const { handlers } = createHandlers(db, withModel);
    const result = (await handlers[JOB_TYPES.CLEANUP]!({})) as { redrafted: number };

    expect(result.redrafted).toBe(0);
  });
});

describe('Автопубликация', () => {
  const ctx = { ipAddress: '127.0.0.1', userAgent: 'vitest' };

  /** Записать настройку публикации напрямую — как это делает раздел настроек. */
  async function setAutoPublish(value: {
    autoPublish: boolean;
    minConfidence?: number;
    delayMinutes?: number;
    enabledBy?: string | null;
  }): Promise<void> {
    await new OpsRepository(db).setSetting(
      'publishing',
      {
        autoPublish: value.autoPublish,
        minConfidence: value.minConfidence ?? 0.3,
        delayMinutes: value.delayMinutes ?? 0,
        enabledBy: value.enabledBy === undefined ? owner.id : value.enabledBy,
        enabledAt: new Date().toISOString(),
      },
      { isCritical: true },
    );
  }

  async function prepareEvent(): Promise<string> {
    adapter.setPosts([
      makePost({
        id: '5001',
        text: 'В Новороссийске на улице Анапское шоссе временно перекрыто движение из-за ремонта теплотрассы.',
      }),
    ]);
    const [eventId] = await ingestAndProcess();
    await draftService.generateForEvent(eventId!);
    return eventId!;
  }

  it('выключенная автопубликация ничего не отправляет', async () => {
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: false });

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(false);
    expect(result.skipped).toMatch(/выключена/i);

    const queue = await new ModerationRepository(db).findByEvent(eventId);
    expect(queue?.status).toBe('PENDING');
  });

  it('включённая автопубликация отправляет материал и помечает событие опубликованным', async () => {
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: true });

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(true);
    // Публикация записана на человека, включившего автопубликацию:
    // решение принял он, и в журнале это должно быть видно.
    expect(result.publication?.publishedBy).toBe(owner.id);
    expect(result.publication?.dryRun).toBe(true);

    const event = await events().findById(eventId);
    expect(event?.status).toBe('PUBLISHED');
  });

  it('материал с уверенностью ниже порога уходит к человеку', async () => {
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: true, minConfidence: 0.99 });

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(false);
    expect(result.skipped).toMatch(/ниже порога/i);

    const queue = await new ModerationRepository(db).findByEvent(eventId);
    expect(queue?.status).toBe('PENDING');
  });

  it('материал, который уже взял человек, автоматика не трогает', async () => {
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: true });
    await new ModerationRepository(db).setStatus(eventId, 'REJECTED', {
      reviewedBy: owner.id,
      rejectionReason: 'Не городская новость',
    });

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(false);
    expect(result.skipped).toMatch(/REJECTED/);
  });

  it('заблокированный лексикой материал не публикуется автоматически', async () => {
    const eventId = await prepareEvent();
    const mat = ['х', 'у', 'й'].join('');
    await draftService.saveManualEdit({
      eventId,
      userId: owner.id,
      title: 'Заголовок новости',
      body: 'Текст новости',
      telegramText: `Заголовок новости\n\nПолный ${mat} текст.`,
    });
    await setAutoPublish({ autoPublish: true });

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(false);
    expect(result.publication).toBeUndefined();
  });

  it('отзыв прав у включившего останавливает отправку', async () => {
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: true });
    // Учётную запись отключили, а переключатель остался включённым.
    await new UsersRepository(db).setActive(owner.id, false);

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(false);
    expect(result.skipped).toMatch(/недоступна/i);

    const queue = await new ModerationRepository(db).findByEvent(eventId);
    expect(queue?.status).toBe('PENDING');
  });

  it('включённая позже автопубликация подхватывает очередь', async () => {
    // Задача автопубликации ставится при создании черновика, поэтому
    // переключатель, включённый после, не действовал ни на что — со
    // стороны это выглядело как «автопубликация не работает».
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: true, delayMinutes: 0 });

    const { handlers } = createHandlers(db, config);
    const result = (await handlers[JOB_TYPES.CLEANUP]!({})) as { autoQueued: number };

    expect(result.autoQueued).toBe(1);

    const job = await db.maybeOne(
      `SELECT payload FROM processing_jobs
        WHERE type = $1 AND status = 'QUEUED'
        ORDER BY created_at DESC LIMIT 1`,
      [JOB_TYPES.AUTO_PUBLISH],
    );
    expect(String((job?.payload as { eventId?: string })?.eventId)).toBe(eventId);
  });

  it('с выключенной автопубликацией очередь не трогается', async () => {
    await prepareEvent();
    await setAutoPublish({ autoPublish: false });

    const { handlers } = createHandlers(db, config);
    const result = (await handlers[JOB_TYPES.CLEANUP]!({})) as { autoQueued: number };

    expect(result.autoQueued).toBe(0);
  });

  it('без записи о том, кто включил, отправки нет', async () => {
    const eventId = await prepareEvent();
    await setAutoPublish({ autoPublish: true, enabledBy: null });

    const result = await publishing.publishAutomatically({ eventId });

    expect(result.ok).toBe(false);
    expect(result.skipped).toMatch(/кто включил/i);
  });
});

describe('Барьеры публикации', () => {
  /** Подготовить событие с черновиком. */
  async function prepareEvent(): Promise<string> {
    adapter.setPosts([
      makePost({
        id: '4001',
        text: 'В Новороссийске на трассе Новороссийск — Керчь затруднено движение из-за дорожных работ.',
      }),
    ]);
    const [eventId] = await ingestAndProcess();
    await draftService.generateForEvent(eventId!);
    return eventId!;
  }

  const ctx = { ipAddress: '127.0.0.1', userAgent: 'vitest' };

  it('без подтверждения человека публикация невозможна', async () => {
    const eventId = await prepareEvent();
    await moderation.approve({ eventId, user: owner, ...ctx });

    const result = await publishing.publish({ eventId, user: owner, ...ctx, confirmed: false });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_CONFIRMED');
  });

  it('без одобрения модератора публикация невозможна', async () => {
    const eventId = await prepareEvent();

    const result = await publishing.publish({ eventId, user: owner, ...ctx, confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_APPROVED');
  });

  it('одобренный материал публикуется (сухой прогон)', async () => {
    const eventId = await prepareEvent();
    const approved = await moderation.approve({ eventId, user: owner, ...ctx });
    expect(approved.ok).toBe(true);

    const result = await publishing.publish({ eventId, user: owner, ...ctx, confirmed: true });

    expect(result.ok).toBe(true);
    expect(result.publication?.dryRun).toBe(true);
    // Сохраняются пользователь, подтвердивший публикацию, и сам текст.
    expect(result.publication?.publishedBy).toBe(owner.id);
    expect(result.publication?.publishedText.length).toBeGreaterThan(10);

    const event = await events().findById(eventId);
    expect(event?.status).toBe('PUBLISHED');
  });

  it('мат, вписанный вручную, блокирует публикацию', async () => {
    const eventId = await prepareEvent();
    const mat = ['х', 'у', 'й'].join('');

    // Модератор вручную правит текст и вписывает недопустимое слово.
    const edit = await draftService.saveManualEdit({
      eventId,
      userId: owner.id,
      title: 'Заголовок новости',
      body: 'Текст новости',
      telegramText: `Заголовок новости\n\nПолный ${mat} текст.`,
    });

    // Правка сохранена, но помечена как не прошедшая проверку.
    expect(edit.allowed).toBe(false);

    // Одобрить такой материал нельзя.
    const approved = await moderation.approve({ eventId, user: owner, ...ctx });
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.code).toBe('PROFANITY_BLOCKED');

    // И опубликовать тоже нельзя.
    const published = await publishing.publish({ eventId, user: owner, ...ctx, confirmed: true });
    expect(published.ok).toBe(false);
  });

  it('повторная проверка ловит мат даже при попытке обойти её напрямую', async () => {
    const eventId = await prepareEvent();
    await moderation.approve({ eventId, user: owner, ...ctx });

    // Имитируем попытку подменить текст в обход интерфейса: запись
    // помечена как прошедшую проверку, хотя текст содержит мат.
    const mat = ['п', 'и', 'з', 'д', 'е', 'ц'].join('');
    await db.query(
      `UPDATE ai_drafts SET telegram_text = $2, profanity_passed = true WHERE event_id = $1 AND is_current`,
      [eventId, `Заголовок\n\nПолный ${mat} в тексте.`],
    );

    // Финальная проверка выполняется заново и не доверяет флагу в БД.
    const result = await publishing.publish({ eventId, user: owner, ...ctx, confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PROFANITY_BLOCKED');

    const queue = await new ModerationRepository(db).findByEvent(eventId);
    expect(queue?.status).toBe('BLOCKED');
  });

  it('реальная отправка без настроенного бота отклоняется', async () => {
    // Сухой прогон проходит и без токена, но настоящая отправка — нет.
    const storage = createStorageDriver(config);
    const realConfig = loadConfig({ ...process.env, TELEGRAM_PUBLISH_DRY_RUN: 'false' });
    const realPublishing = new PublishingService(db, realConfig, storage);

    const eventId = await prepareEvent();
    await moderation.approve({ eventId, user: owner, ...ctx });

    const result = await realPublishing.publish({ eventId, user: owner, ...ctx, confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NOT_CONFIGURED');
  });

  it('публикация без источников невозможна', async () => {
    const eventId = await prepareEvent();
    await moderation.approve({ eventId, user: owner, ...ctx });

    // Убираем связи с публикациями.
    await db.query('DELETE FROM event_sources WHERE event_id = $1', [eventId]);

    const result = await publishing.publish({ eventId, user: owner, ...ctx, confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MISSING_SOURCES');
  });

  it('роль без прав не может публиковать', async () => {
    const eventId = await prepareEvent();
    await moderation.approve({ eventId, user: owner, ...ctx });

    const viewer: User = { ...owner, id: owner.id, role: 'VIEWER' };
    const result = await publishing.publish({ eventId, user: viewer, ...ctx, confirmed: true });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('FORBIDDEN');
  });

  it('каждая попытка публикации фиксируется в аудите', async () => {
    const eventId = await prepareEvent();
    await publishing.publish({ eventId, user: owner, ...ctx, confirmed: false });

    const entries = await db.many(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`,
      [eventId],
    );
    const actions = entries.map((e) => String(e.action));
    expect(actions).toContain('publish.attempt');
    expect(actions).toContain('publish.blocked');
  });
});

describe('История версий черновика', () => {
  it('ручная правка создаёт новую версию, не затирая предыдущую', async () => {
    adapter.setPosts([
      makePost({ id: '5001', text: 'В Новороссийске открыли новый многофункциональный центр для жителей.' }),
    ]);
    const [eventId] = await ingestAndProcess();
    const first = await draftService.generateForEvent(eventId!);

    await draftService.saveManualEdit({
      eventId: eventId!,
      userId: owner.id,
      title: 'Исправленный заголовок',
      body: 'Исправленный текст новости.',
      telegramText: 'Исправленный заголовок\n\nИсправленный текст новости.',
    });

    const history = await drafts().history(eventId!);
    expect(history.length).toBe(2);
    expect(history[0]!.version).toBe(2);
    expect(history[0]!.createdBy).toBe('HUMAN');
    // Предыдущая версия сохранена целиком.
    expect(history[1]!.id).toBe(first!.id);
    expect(history[1]!.isCurrent).toBe(false);
  });
});

describe('Ежедневная очистка очереди модерации', () => {
  it('закрывает вчерашние материалы и не трогает сегодняшние', async () => {
    const db = await getTestDb();
    const moderation = new ModerationRepository(db);

    const source = await db.one<{ id: string }>(
      `INSERT INTO sources (type, title, username, url, is_active)
       VALUES ('TELEGRAM','Тест','t','https://t.me/t', true) RETURNING id`,
    );

    // Две записи: одна создана до сегодняшней полуночи по Москве, другая после.
    const mkEvent = async (title: string) =>
      db.one<{ id: string }>(
        `INSERT INTO events (title, summary, category_slug, importance, occurred_at,
                             first_reported_at, last_reported_at, status)
         VALUES ($1, $1, 'other', 'MEDIUM', now(), now(), now(), 'PROCESSED') RETURNING id`,
        [title],
      );

    const yesterday = await mkEvent('Вчерашнее');
    const today = await mkEvent('Сегодняшнее');

    await db.query(
      `INSERT INTO moderation_queue (event_id, status, priority, created_at)
       VALUES ($1,'PENDING','MEDIUM',
               (date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') - interval '1 hour')
                 AT TIME ZONE 'Europe/Moscow')`,
      [yesterday.id],
    );
    await db.query(
      `INSERT INTO moderation_queue (event_id, status, priority, created_at)
       VALUES ($1,'PENDING','MEDIUM', now())`,
      [today.id],
    );

    const closed = await moderation.expireStale();
    expect(closed).toBe(1);

    const rows = await db.many<{ status: string; rejection_reason: string | null; title: string }>(
      `SELECT mq.status, mq.rejection_reason, e.title
         FROM moderation_queue mq JOIN events e ON e.id = mq.event_id
        ORDER BY e.title`,
    );
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('Вчерашнее')?.status).toBe('REJECTED');
    expect(byTitle.get('Вчерашнее')?.rejection_reason).toMatch(/Автоочистка/);
    // Сегодняшнее остаётся в работе — иначе очередь опустела бы среди дня.
    expect(byTitle.get('Сегодняшнее')?.status).toBe('PENDING');

    await db.query('DELETE FROM sources WHERE id = $1', [source.id]);
  });
});
