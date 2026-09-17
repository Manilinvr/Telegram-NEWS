import { z } from 'zod';
import {
  aiDedupVerdictSchema,
  aiEventAnalysisSchema,
  aiPostClassificationSchema,
  type AiDedupVerdict,
  type AiEventAnalysis,
  type AiPostClassification,
} from '@nnm/shared';

/**
 * Контракт провайдера AI.
 *
 * Провайдер отвечает только за общение с моделью. Проверка схемы, повторы
 * и контроль лексики живут уровнем выше, поэтому заменить модель или
 * подключить локальную можно, не трогая pipeline.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Доступен ли провайдер при текущей конфигурации. */
  isAvailable(): boolean;
  complete(input: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

export class AiResponseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'AiResponseError';
  }
}

/**
 * Извлечь JSON из ответа модели.
 *
 * Модель просят отвечать «только JSON», но на практике ответ иногда
 * приходит в ```json-блоке или с пояснением до/после. Вместо того чтобы
 * ронять задачу, JSON аккуратно извлекается — при этом любая некорректная
 * структура всё равно будет отклонена валидацией схемы.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Берём фрагмент от первой открывающей до последней закрывающей скобки.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        throw new AiResponseError('Ответ модели не является корректным JSON', raw);
      }
    }
    throw new AiResponseError('В ответе модели не найден JSON', raw);
  }
}

/**
 * Разобрать и проверить ответ по схеме; ошибки схемы читаемы в логах.
 *
 * Тип выводится из самой схемы (`z.infer`), а не задаётся отдельным
 * параметром: у схем с `.default()` входной и выходной типы различаются,
 * и `z.ZodType<T>` их не согласует.
 */
export function parseWithSchema<S extends z.ZodTypeAny>(raw: string, schema: S): z.infer<S> {
  const json = extractJson(raw);
  const result = schema.safeParse(json);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
      .join('; ');
    throw new AiResponseError(`Ответ модели не соответствует схеме: ${issues}`, raw);
  }
  return result.data;
}

export const parseEventAnalysis = (raw: string): AiEventAnalysis =>
  parseWithSchema(raw, aiEventAnalysisSchema);

export const parseClassification = (raw: string): AiPostClassification =>
  parseWithSchema(raw, aiPostClassificationSchema);

export const parseDedupVerdict = (raw: string): AiDedupVerdict =>
  parseWithSchema(raw, aiDedupVerdictSchema);
