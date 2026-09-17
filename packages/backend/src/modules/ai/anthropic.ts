import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { AiUnavailableError, type AiProvider } from './provider.js';

const log = childLogger({ module: 'ai-anthropic' });

/**
 * Провайдер Anthropic.
 *
 * SDK импортируется динамически: при AI_PROVIDER=mock пакет не загружается
 * вовсе и не влияет на запуск воркеров.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: unknown;

  constructor(private readonly config: AppConfig) {}

  get model(): string {
    return this.config.AI_MODEL;
  }

  isAvailable(): boolean {
    return Boolean(this.config.ANTHROPIC_API_KEY);
  }

  private async getClient() {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({
        apiKey: this.config.ANTHROPIC_API_KEY as string,
        timeout: this.config.AI_TIMEOUT_MS,
        maxRetries: 2,
      });
    }
    return this.client as import('@anthropic-ai/sdk').default;
  }

  async complete(input: { system: string; user: string; maxTokens?: number }): Promise<string> {
    if (!this.isAvailable()) {
      throw new AiUnavailableError('Не задан ANTHROPIC_API_KEY.');
    }

    const client = await this.getClient();
    const started = Date.now();

    try {
      const response = await client.messages.create({
        model: this.config.AI_MODEL,
        max_tokens: input.maxTokens ?? this.config.AI_MAX_OUTPUT_TOKENS,
        // Низкая температура: задача — извлечь факты, а не сочинить текст.
        temperature: this.config.AI_TEMPERATURE,
        system: input.system,
        messages: [{ role: 'user', content: input.user }],
      });

      const text = response.content
        .filter((block): block is { type: 'text'; text: string; citations?: unknown } =>
          block.type === 'text',
        )
        .map((block) => block.text)
        .join('\n');

      log.debug(
        {
          model: this.config.AI_MODEL,
          durationMs: Date.now() - started,
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        },
        'Получен ответ модели',
      );

      return text;
    } catch (error) {
      // Недоступность модели — не потеря материала: задача вернётся в
      // очередь и повторится, публикация останется ждать (ТЗ §24).
      throw new AiUnavailableError(`Ошибка обращения к Anthropic API: ${(error as Error).message}`);
    }
  }
}
