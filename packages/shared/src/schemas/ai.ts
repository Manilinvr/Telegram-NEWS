import { z } from 'zod';
import { IMPORTANCE } from '../domain/statuses.js';

/**
 * Строгая схема структурированного ответа AI (ТЗ §29).
 *
 * AI обязан возвращать JSON, а не свободный текст. Схема валидируется на
 * backend ДО того, как результат попадёт в БД: некорректный ответ модели
 * отклоняется и задача уходит на повтор, а не создаёт «мусорное» событие.
 */

/**
 * Перечисление задаётся литералами из IMPORTANCE, а не приведением массива
 * к [string, ...string[]]: приведение стирает union-тип, и `importance`
 * выводится как обычная строка, из-за чего ответ модели перестаёт
 * проверяться типами на стороне вызывающего кода.
 */
const importanceEnum = z.enum([
  IMPORTANCE.LOW,
  IMPORTANCE.MEDIUM,
  IMPORTANCE.HIGH,
  IMPORTANCE.CRITICAL,
]);

/** Отдельный извлечённый факт с обязательной пометкой о его статусе. */
export const aiFactSchema = z.object({
  /** Формулировка факта — без домыслов, только то, что есть в источнике. */
  text: z.string().min(3).max(600),
  /** Подтверждён ли факт более чем одним независимым источником. */
  confirmed: z.boolean().default(false),
  /**
   * true — это предположение/версия, а не установленный факт.
   * AI обязан разделять факты и предположения (ТЗ §8).
   */
  assumption: z.boolean().default(false),
  /** Атрибуция: «по словам очевидца», «как сообщает источник». */
  attribution: z.string().max(200).nullable().default(null),
  /** Индекс исходной публикации из переданного списка (0-based). */
  sourceIndex: z.number().int().min(0).nullable().default(null),
});

export type AiFact = z.infer<typeof aiFactSchema>;

/** Утверждение, привязанное к конкретному источнику. */
export const aiSourceClaimSchema = z.object({
  claim: z.string().min(3).max(600),
  sourceIndex: z.number().int().min(0),
  attribution: z.string().max(200).nullable().default(null),
});

export type AiSourceClaim = z.infer<typeof aiSourceClaimSchema>;

/** Цитата очевидца, отобранная из транскрипции видео. */
export const aiWitnessQuoteSchema = z.object({
  text: z.string().min(3).max(500),
  /** Таймкод в секундах, если известен. */
  timecode: z.number().min(0).nullable().default(null),
  speaker: z.string().max(100).nullable().default(null),
});

export type AiWitnessQuote = z.infer<typeof aiWitnessQuoteSchema>;

/** Полный ответ AI по одному событию. */
export const aiEventAnalysisSchema = z.object({
  title: z.string().min(5).max(200),
  summary: z.string().min(10).max(1200),
  category: z.string().min(1).max(64),
  importance: importanceEnum,
  location: z.string().max(300).nullable().default(null),
  /** Предполагаемое время происшествия в ISO-8601 или null. */
  eventTime: z.string().max(64).nullable().default(null),
  facts: z.array(aiFactSchema).max(30).default([]),
  /** Явно неподтверждённые сведения — обязаны быть отмечены. */
  uncertainties: z.array(z.string().min(3).max(400)).max(20).default([]),
  sourceClaims: z.array(aiSourceClaimSchema).max(30).default([]),
  witnessQuotes: z.array(aiWitnessQuoteSchema).max(10).default([]),
  /** Оригинальный редакционный текст для Telegram. */
  draft: z.string().min(20).max(4000),
  confidence: z.number().min(0).max(1),
});

export type AiEventAnalysis = z.infer<typeof aiEventAnalysisSchema>;

/**
 * Ответ AI на запрос о том, описывают ли две публикации одно событие.
 * Используется как дополнительный сигнал дедупликации при пограничном score.
 */
export const aiDedupVerdictSchema = z.object({
  sameEvent: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});

export type AiDedupVerdict = z.infer<typeof aiDedupVerdictSchema>;

/** Быстрая классификация одной публикации (до построения события). */
export const aiPostClassificationSchema = z.object({
  category: z.string().min(1).max(64),
  importance: importanceEnum,
  /** Является ли публикация новостью вообще (а не рекламой/опросом). */
  isNews: z.boolean().default(true),
  location: z.string().max(300).nullable().default(null),
  /** Краткое содержание в одну строку — для ленты. */
  headline: z.string().min(5).max(200),
  /** Ключевые сущности: топонимы, организации, объекты. */
  entities: z.array(z.string().min(1).max(120)).max(30).default([]),
  confidence: z.number().min(0).max(1),
});

export type AiPostClassification = z.infer<typeof aiPostClassificationSchema>;
