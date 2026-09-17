/**
 * Демонстрационные данные для приёмки интерфейса.
 *
 * Скрипт наполняет базу правдоподобной городской повесткой, прогоняя её
 * через НАСТОЯЩИЙ конвейер: публикации сохраняются как пришедшие из
 * источника, затем классифицируются, объединяются в события и получают
 * черновики. Это проверяет систему целиком, а не только вид интерфейса.
 *
 * Скрипт предназначен для разработки и демонстрации. В production его
 * запускать не нужно: он создаёт вымышленные новости.
 */
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { AiProcessor } from '../modules/ai/processor.js';
import { createEmbeddingProvider } from '../modules/dedup/embeddings.js';
import { EmbeddingRepository } from '../modules/dedup/repository.js';
import { AdapterRegistry } from '../modules/ingestion/registry.js';
import { IngestionService } from '../modules/ingestion/service.js';
import type { FetchOptions, FetchResult, FetchedPost, SourceAdapter } from '../modules/ingestion/types.js';
import { DraftService } from '../modules/pipeline/draft-service.js';
import { EventBuilder } from '../modules/pipeline/event-builder.js';
import { createStorageDriver } from '../modules/storage/driver.js';
import { TranscriptionService } from '../modules/transcription/service.js';
import { CategoriesRepository } from '../repositories/categories.js';
import { SourcesRepository } from '../repositories/sources.js';

const config = getConfig();
const db = createDatabase(config);

if (config.isProduction) {
  process.stderr.write('Демонстрационные данные нельзя создавать в production.\n');
  process.exit(1);
}

/** Источники городской повестки. */
const DEMO_SOURCES = [
  { title: 'ТГ Краснодарский край', username: 'demo_krasnodar_kray', type: 'TELEGRAM' as const },
  { title: 'ТГ Новороссийск', username: 'demo_novoros', type: 'TELEGRAM' as const },
  { title: 'ТГ Типичный Новороссийск', username: 'demo_tipichny', type: 'TELEGRAM' as const },
  { title: 'VK Новороссийск', username: 'demo_vk_novoros', type: 'VK' as const },
  { title: 'VK Мой Новороссийск', username: 'demo_vk_moy', type: 'VK' as const },
];

/**
 * Публикации. Часть из них намеренно описывает ОДНО событие разными
 * словами — так проверяется объединение, — а часть похожа лексически,
 * но относится к разным происшествиям.
 */
const DEMO_POSTS: Array<{ source: number; minutesAgo: number; text: string }> = [
  {
    source: 1,
    minutesAgo: 25,
    text: 'В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей. По предварительной информации, пострадавших нет. На месте работают сотрудники ДПС, движение затруднено.',
  },
  {
    source: 2,
    minutesAgo: 18,
    text: 'ДТП на улице Видова: столкнулись две легковые машины. Очевидцы сообщают о затруднённом движении в сторону центра. Полиция уже на месте.',
  },
  {
    source: 3,
    minutesAgo: 12,
    text: 'Авария на Видова в Новороссийске. Две машины, обошлось без пострадавших, по словам очевидца. Образовалась пробка.',
  },
  {
    source: 0,
    minutesAgo: 95,
    text: 'В Восточном районе Новороссийска временно отключили электричество из-за аварии на сетях. Ремонтные бригады уже работают, подачу планируют восстановить к вечеру.',
  },
  {
    source: 4,
    minutesAgo: 88,
    text: 'Без света остались несколько улиц Восточного района. В администрации сообщили, что причина — повреждение кабельной линии.',
  },
  {
    source: 1,
    minutesAgo: 170,
    text: 'Пожар в жилом доме на Анапском шоссе. На место выехали пожарные расчёты МЧС. Жильцов эвакуировали, пострадавших нет.',
  },
  {
    source: 2,
    minutesAgo: 240,
    text: 'На трассе Новороссийск — Керчь затруднено движение из-за дорожных работ. Водителям рекомендуют выбирать альтернативные маршруты и закладывать дополнительное время.',
  },
  {
    source: 3,
    minutesAgo: 320,
    text: 'В Новороссийске на набережной Адмирала Серебрякова 17 мая пройдёт фестиваль уличной культуры. В программе — музыка, мастер-классы и выставка работ местных художников.',
  },
  {
    source: 0,
    minutesAgo: 400,
    text: 'Грузооборот порта Новороссийск вырос по итогам квартала. В компании отмечают увеличение перевалки зерновых грузов.',
  },
  {
    source: 4,
    minutesAgo: 480,
    text: 'В Новороссийске открыли новый многофункциональный центр для жителей Южного района. Приём документов начнётся со следующей недели.',
  },
  {
    source: 2,
    minutesAgo: 540,
    text: 'Синоптики предупреждают: в Новороссийске ожидается усиление норд-оста до 20 метров в секунду. Рекомендуется убрать с балконов незакреплённые предметы.',
  },
  {
    source: 1,
    minutesAgo: 610,
    text: 'В Новороссийске на Анапском шоссе произошло ДТП, столкнулись два автомобиля. Движение в сторону выезда из города затруднено.',
  },
  {
    source: 3,
    minutesAgo: 700,
    text: 'Задержка рейсов в аэропорту зафиксирована из-за погодных условий. Пассажирам рекомендуют уточнять информацию у перевозчика.',
  },
  {
    source: 4,
    minutesAgo: 780,
    text: 'Спасатели напомнили жителям Новороссийска о правилах поведения на воде в штормовую погоду. За выходные зафиксировано несколько случаев нарушения запрета на купание.',
  },
  {
    source: 0,
    minutesAgo: 860,
    text: 'В городском парке Новороссийска завершилось благоустройство: обновили дорожки, установили новые скамейки и освещение.',
  },
];

/** Адаптер, отдающий заранее подготовленные публикации. */
class DemoAdapter implements SourceAdapter {
  readonly type = 'TELEGRAM' as const;
  readonly mode = 'demo';
  private queue: FetchedPost[] = [];

  setPosts(posts: FetchedPost[]): void {
    this.queue = posts;
  }
  isConfigured(): boolean {
    return true;
  }
  unavailableReason(): null {
    return null;
  }
  async fetch(_source: never, options: FetchOptions): Promise<FetchResult> {
    const posts = this.queue.slice(0, options.limit);
    this.queue = [];
    return { posts, lastExternalId: posts.at(-1)?.externalId ?? null };
  }
  async verify(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

try {
  const categories = new CategoriesRepository(db);
  await categories.seedDefaults();
  const categoryList = await categories.list();

  const sourcesRepo = new SourcesRepository(db);
  const existing = await sourcesRepo.list();

  const sourceIds: string[] = [];
  for (const demo of DEMO_SOURCES) {
    const found = existing.find((s) => s.username === demo.username);
    if (found) {
      sourceIds.push(found.id);
      continue;
    }
    const created = await sourcesRepo.create({
      type: demo.type,
      title: demo.title,
      username: demo.username,
      url:
        demo.type === 'TELEGRAM'
          ? `https://t.me/${demo.username}`
          : `https://vk.com/${demo.username}`,
      notes: 'Демонстрационный источник. Реальные публикации не загружаются.',
    });
    sourceIds.push(created.id);
  }
  logger.info({ count: sourceIds.length }, 'Демонстрационные источники готовы');

  const adapter = new DemoAdapter();
  const registry = new AdapterRegistry(config);
  registry.register('TELEGRAM', adapter);
  registry.register('VK', adapter as never);

  const ingestion = new IngestionService(db, registry, config);
  const storage = createStorageDriver(config);
  const embeddings = new EmbeddingRepository(db, createEmbeddingProvider(config));
  const transcription = new TranscriptionService(db, storage, config);
  const ai = new AiProcessor(
    config,
    categoryList.map((c) => ({
      slug: c.slug,
      title: c.title,
      keywords: c.keywords,
      defaultImportance: c.defaultImportance,
    })),
  );
  const builder = new EventBuilder(db, ai, embeddings, config);
  const draftService = new DraftService(db, ai, config, transcription);

  // Публикации раскладываются по своим источникам и проходят обычный путь.
  for (const [index, sourceId] of sourceIds.entries()) {
    const posts = DEMO_POSTS.filter((post) => post.source === index).map((post, order) => ({
      externalId: `demo-${index}-${order}-${Math.round(post.minutesAgo)}`,
      url: `https://t.me/${DEMO_SOURCES[index]?.username}/${1000 + order}`,
      postedAt: new Date(Date.now() - post.minutesAgo * 60_000),
      text: post.text,
      isForward: false,
      forwardFrom: null,
      media: [],
      metadata: { demo: true },
    }));

    if (posts.length === 0) continue;
    adapter.setPosts(posts);

    const source = await sourcesRepo.findById(sourceId);
    if (source) await ingestion.syncSource(source);
  }

  // Обработка: классификация, дедупликация, построение событий.
  const pending = await db.many(`SELECT id FROM source_posts WHERE status = 'NEW' ORDER BY posted_at`);
  const eventIds = new Set<string>();

  for (const row of pending) {
    const outcome = await builder.processPost(String(row.id));
    if (outcome.eventId) eventIds.add(outcome.eventId);
  }
  logger.info({ posts: pending.length, events: eventIds.size }, 'Публикации обработаны');

  // Черновики для каждого события.
  for (const eventId of eventIds) {
    await draftService.generateForEvent(eventId);
  }
  logger.info({ count: eventIds.size }, 'Черновики созданы');

  const stats = await db.one(`
    SELECT
      (SELECT count(*) FROM sources)::int AS sources,
      (SELECT count(*) FROM source_posts)::int AS posts,
      (SELECT count(*) FROM events WHERE merged_into_event_id IS NULL)::int AS events,
      (SELECT count(*) FROM ai_drafts)::int AS drafts,
      (SELECT count(*) FROM moderation_queue)::int AS queue
  `);

  process.stdout.write(
    `\nДемонстрационные данные созданы:\n` +
      `  источников: ${stats.sources}\n` +
      `  публикаций: ${stats.posts}\n` +
      `  событий:    ${stats.events}\n` +
      `  черновиков: ${stats.drafts}\n` +
      `  в очереди:  ${stats.queue}\n\n`,
  );

  await db.close();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Не удалось создать демонстрационные данные');
  await db.close();
  process.exit(1);
}
