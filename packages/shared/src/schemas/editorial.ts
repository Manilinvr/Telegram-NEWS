import { z } from 'zod';

/**
 * Редакционный стиль канала (ТЗ §8, §11).
 *
 * Тон подачи — редакционное решение, а не свойство кода: его меняют,
 * глядя на вышедшие посты, и не раз. Поэтому он хранится в настройках и
 * правится в интерфейсе, а не в системном промпте, до которого на
 * хостинге не дотянуться.
 *
 * Границы намеренные: стиль управляет ТОНОМ, длиной и оформлением, но не
 * может отменить ни одно правило работы с фактами. Запрет выдумывать
 * сведения, обязательная атрибуция и проверка лексики остаются в силе при
 * любом значении этих настроек — иначе настройка тона стала бы способом
 * обойти защиту, которая и составляет ценность системы.
 */

export const EDITORIAL_TONES = ['neutral', 'official', 'lively', 'brief'] as const;
export type EditorialTone = (typeof EDITORIAL_TONES)[number];

/** Названия для интерфейса. Текст самих указаний модели живёт на backend. */
export const EDITORIAL_TONE_LABELS: Record<EditorialTone, string> = {
  neutral: 'Нейтральный',
  official: 'Официальный',
  lively: 'Живой',
  brief: 'Телеграфный',
};

export const EDITORIAL_TONE_HINTS: Record<EditorialTone, string> = {
  neutral: 'Информационная подача без оценок. Подходит для ленты происшествий.',
  official: 'Сдержанные формулировки, полные названия служб и должностей.',
  lively: 'Человеческая интонация и простые слова, но без шуток и панибратства.',
  brief: 'Только суть: короткие предложения, минимум деталей.',
};

export const editorialStyleSchema = z.object({
  tone: z.enum(EDITORIAL_TONES).default('neutral'),

  /**
   * Длина краткого изложения. Ограничение предложениями, а не символами:
   * модель держит его надёжнее, а обрезку по длине всё равно выполняет
   * сборка поста.
   */
  summaryMaxSentences: z.number().int().min(1).max(6).default(3),

  /** Строки «📍 место» и «🕒 время» в готовом посте. */
  useEmoji: z.boolean().default(true),

  /** Подпись в конце поста, например «@novotoday». Пусто — без подписи. */
  signature: z.string().max(80).nullable().default(null),

  /**
   * Свободные указания редакции: чего избегать, как называть район, какие
   * обороты предпочитать. Уходят в промпт отдельным разделом с оговоркой,
   * что правила работы с фактами они не отменяют.
   */
  extraInstructions: z.string().max(2000).default(''),
});

export type EditorialStyle = z.infer<typeof editorialStyleSchema>;

export const DEFAULT_EDITORIAL_STYLE: EditorialStyle = editorialStyleSchema.parse({});

/** Ключ настройки в таблице settings. */
export const EDITORIAL_SETTING_KEY = 'editorial';
