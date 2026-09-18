import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { AiUnavailableError, type AiProvider } from './provider.js';

const log = childLogger({ module: 'ai-openai-compatible' });

/**
 * Провайдер для любой службы с интерфейсом OpenAI.
 *
 * Зачем он нужен: переформулировать текст, сохраняя смысл, умеет только
 * модель, а платить за неё готов не каждый. Этот протокол поддерживают
 * десятки служб, среди которых есть бесплатные тарифы, и локальные
 * модели, работающие на своём железе без оплаты вообще. Адрес и название
 * модели задаются переменными окружения, поэтому службу можно сменить,
 * не трогая код.
 *
 * Обращение идёт обычным HTTP-запросом, без SDK: протокол здесь
 * простой, а лишняя зависимость означала бы привязку к конкретной службе.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly config: AppConfig) {}

  get model(): string {
    return this.config.AI_MODEL;
  }

  isAvailable(): boolean {
    return Boolean(this.config.AI_BASE_URL);
  }

  async complete(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
    if (!this.isAvailable()) {
      throw new AiUnavailableError('Не задан AI_BASE_URL — адрес службы с интерфейсом OpenAI.');
    }

    const url = `${(this.config.AI_BASE_URL as string).replace(/\/+$/, '')}/chat/completions`;
    const started = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Часть служб работает без ключа (например, локальная модель),
          // поэтому заголовок добавляется только когда ключ задан.
          ...(this.config.AI_API_KEY ? { authorization: `Bearer ${this.config.AI_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: input.maxTokens ?? this.config.AI_MAX_OUTPUT_TOKENS,
          temperature: this.config.AI_TEMPERATURE,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
        signal: AbortSignal.timeout(this.config.AI_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiUnavailableError(
        `Служба модели недоступна: ${(error as Error).message}. Проверьте AI_BASE_URL.`,
      );
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new AiUnavailableError(explainFailure(response, raw));
    }

    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new AiUnavailableError(`Служба модели вернула не JSON: ${raw.slice(0, 200)}`);
    }

    const text = body.choices?.[0]?.message?.content;
    if (!text) {
      throw new AiUnavailableError(`Служба модели вернула пустой ответ: ${raw.slice(0, 200)}`);
    }

    log.debug({ model: this.model, ms: Date.now() - started }, 'Ответ модели получен');
    return text;
  }
}

/**
 * Объяснить отказ службы словами.
 *
 * Сырой JSON ответа обрезался по длине и попадал в интерфейс оборванным
 * на середине служебного поля. Между тем отказов, которые случаются на
 * практике, всего несколько, и у каждого есть понятная причина и понятное
 * действие. Остальные отдаются как есть: придумывать объяснение тому,
 * чего не знаешь, хуже, чем показать ответ службы.
 */
function explainFailure(response: Response, raw: string): string {
  const message = extractMessage(raw);

  if (response.status === 429) {
    const reset = formatReset(response.headers.get('x-ratelimit-reset'));
    const limit = response.headers.get('x-ratelimit-limit');
    return (
      'Исчерпан лимит запросов к службе модели' +
      (limit ? ` (${limit} в сутки)` : '') +
      '. ' +
      (reset ? `Лимит обновится ${reset}. ` : '') +
      'До этого разбор идёт по правилам. ' +
      (message ? `Ответ службы: ${message}` : '')
    ).trim();
  }

  if (response.status === 402) {
    return `Недостаточно средств на счёте службы модели. ${message || 'Пополните баланс.'}`;
  }

  if (response.status === 401 || response.status === 403) {
    return `Служба модели не приняла ключ (HTTP ${response.status}). Проверьте AI_API_KEY. ${message}`.trim();
  }

  if (response.status === 404) {
    return (
      `Служба модели не нашла модель или адрес (HTTP 404). ` +
      `Проверьте AI_MODEL и AI_BASE_URL — адрес указывается до /chat/completions. ${message}`
    ).trim();
  }

  return `Служба модели вернула HTTP ${response.status}: ${message || raw.slice(0, 300)}`;
}

/** Достать человеческую часть из ответа об ошибке. */
function extractMessage(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const error = body.error;
    const text =
      typeof error === 'string' ? error : (error?.message ?? body.message ?? '');
    return String(text).slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

/**
 * Момент обновления лимита. Службы присылают его то секундами, то
 * миллисекундами, то количеством секунд ожидания — разбираем все три.
 */
function formatReset(value: string | null): string | null {
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;

  const now = Date.now();
  const timestamp =
    number > 1e12 ? number : number > 1e9 ? number * 1000 : now + number * 1000;
  if (timestamp < now) return null;

  return new Date(timestamp).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
