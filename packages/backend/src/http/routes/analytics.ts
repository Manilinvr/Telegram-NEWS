import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import { AnalyticsService } from '../../modules/analytics/service.js';
import type { StorageDriver } from '../../modules/storage/driver.js';

const periodSchema = z.object({
  period: z.enum(['24h', '7d', '30d']).default('24h'),
});

export default async function analyticsRoutes(
  app: FastifyInstance,
  options: { db: Database; storage: StorageDriver },
) {
  const analytics = new AnalyticsService(options.db, options.storage);

  /** Всё для главного экрана одним запросом. */
  app.get('/analytics/dashboard', { preHandler: app.requireAuth }, async (request) => {
    const parsed = periodSchema.safeParse(request.query);
    return analytics.bundle(parsed.success ? parsed.data.period : '24h');
  });

  app.get('/analytics/summary', { preHandler: app.requireAuth }, async () => analytics.summary());

  app.get('/analytics/timeseries', { preHandler: app.requireAuth }, async (request) => {
    const parsed = periodSchema.safeParse(request.query);
    return { points: await analytics.timeseries(parsed.success ? parsed.data.period : '24h') };
  });

  app.get('/analytics/categories', { preHandler: app.requireAuth }, async (request) => {
    const parsed = z.object({ hours: z.coerce.number().int().min(1).max(8760).default(24) }).safeParse(request.query);
    return { categories: await analytics.categoryDistribution(parsed.success ? parsed.data.hours : 24) };
  });

  app.get('/analytics/sources', { preHandler: app.requireAuth }, async (request) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(8),
        hours: z.coerce.number().int().min(1).max(8760).default(24),
      })
      .safeParse(request.query);
    const { limit, hours } = parsed.success ? parsed.data : { limit: 8, hours: 24 };
    return { sources: await analytics.topSources(limit, hours) };
  });

  /** Точки для карты событий. */
  app.get('/analytics/map', { preHandler: app.requireAuth }, async (request) => {
    const parsed = z.object({ hours: z.coerce.number().int().min(1).max(8760).default(24) }).safeParse(request.query);
    return { markers: await analytics.mapMarkers(parsed.success ? parsed.data.hours : 24) };
  });
}
