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
      // Текст ответа службы полезнее кода: там обычно написано,
      // исчерпан ли бесплатный лимит или не найдена модель.
      throw new AiUnavailableError(
        `Служба модели вернула HTTP ${response.status}: ${raw.slice(0, 300)}`,
      );
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
