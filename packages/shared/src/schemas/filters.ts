import { z } from 'zod';
import {
  CONFIRMATION_STATUSES,
  IMPORTANCE_LEVELS,
  MODERATION_STATUSES,
  PROCESSING_STATUSES,
} from '../domain/statuses.js';

/**
 * Схема фильтров ленты (ТЗ §6).
 *
 * Все фильтры комбинируются между собой (AND) и транслируются в один
 * SQL-запрос с параметрами — без склейки строк, чтобы исключить инъекции.
 */

/** Разбор `a,b,c` в массив; пустые значения отбрасываются. */
const csv = <T extends string>(values: readonly T[]) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : value.split(',')))
    .transform((items) => items.map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values as unknown as [T, ...T[]])))
    .optional();

const csvFree = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')))
  .transform((items) => items.map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().min(1).max(128)))
  .optional();

/** Строка "true"/"false" из query string в boolean. */
const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')
  .optional();

export const feedFilterSchema = z.object({
  // --- период ---
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  /** Пресет периода: перекрывается явными from/to. */
  period: z.enum(['1h', '24h', '7d', '30d', 'all']).optional(),

  // --- классификация ---
  categories: csvFree,
  importance: csv(IMPORTANCE_LEVELS),
  sources: csvFree,
  sourceTypes: csv(['TELEGRAM', 'VK'] as const),

  // --- что показывать: события, публикации или всё ---
  kind: z.enum(['all', 'events', 'posts']).default('all'),

  // --- статусы ---
  status: csv(PROCESSING_STATUSES),
  moderationStatus: csv(MODERATION_STATUSES),
  confirmationStatus: csv(CONFIRMATION_STATUSES),

  // --- confidence ---
  confidenceMin: z.coerce.number().min(0).max(1).optional(),
  confidenceMax: z.coerce.number().min(0).max(1).optional(),

  // --- наличие вложений и артефактов обработки ---
  hasPhoto: boolish,
  hasVideo: boolish,
  hasTranscript: boolish,
  hasDraft: boolish,
  isPublished: boolish,

  // --- полнотекстовый поиск ---
  /**
   * Ищет по заголовку, исходному тексту, извлечённым фактам,
   * транскрипции и названию источника (ТЗ §6).
   */
  q: z.string().max(300).optional(),
  searchFields: csv(['title', 'rawText', 'facts', 'transcript', 'source'] as const),

  // --- сортировка и постраничность ---
  sort: z.enum(['newest', 'oldest', 'importance', 'confidence', 'sources']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
});

export type FeedFilter = z.infer<typeof feedFilterSchema>;
/** Тип «на входе» — то, что приходит из query string до трансформации. */
export type FeedFilterInput = z.input<typeof feedFilterSchema>;

/** Перевод пресета периода в количество часов. */
export const PERIOD_HOURS: Record<string, number | null> = {
  '1h': 1,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  all: null,
};
