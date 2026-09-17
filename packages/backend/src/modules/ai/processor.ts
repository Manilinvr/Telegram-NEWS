import type {
  AiEventAnalysis,
  AiPostClassification,
  ProfanityReport,
} from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { ProfanityGuard } from '../profanity/index.js';
import { AnthropicProvider } from './anthropic.js';
import { HeuristicAnalyzer, type HeuristicCategory } from './heuristic.js';
import {
  AiResponseError,
  AiUnavailableError,
  parseClassification,
  parseEventAnalysis,
  type AiProvider,
} from './provider.js';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  EDITORIAL_SYSTEM_PROMPT,
  buildClassificationUserMessage,
  buildEditorialUserMessage,
} from './prompts.js';

const log = childLogger({ module: 'ai-processor' });

export interface EventAnalysisInput {
  posts: Array<{
    index: number;
    sourceTitle: string;
    postedAt: string;
    text: string;
    url: string | null;
  }>;
  transcripts: Array<{ mediaLabel: string; text: string }>;
  existingLocation?: string | null;
}

export interface AnalysisOutcome {
  analysis: AiEventAnalysis;
  /** Чем получен результат: моделью или правилами. */
  producedBy: 'AI' | 'HEURISTIC';
  model: string | null;
  /** Обязательная проверка лексики результата. */
  profanityReport: ProfanityReport;
  /** Потребовалась ли повторная генерация из-за запрещённой лексики. */
  regenerated: boolean;
  /** Сырой ответ модели — сохраняется для расследования. */
  raw: unknown;
  warnings: string[];
}

/**
 * AIProcessor (ТЗ §8, §18).
 *
 * Отвечает за весь путь от исходных публикаций до проверенного черновика:
 * подготовка входных данных, вызов модели, валидация схемы, обязательная
 * проверка лексики и деградация к правилам при недоступности модели.
 *
 * Два принципа определяют устройство класса:
 *
 *  • Недоступность или сбой модели не должны терять материал. Любая ошибка
 *    приводит к разбору по правилам с низкой уверенностью, и событие
 *    уходит на ручную проверку, а не исчезает (ТЗ §24).
 *
 *  • Ни один текст не покидает этот класс без проверки ProfanityGuard.
 *    Проверка встроена в возвращаемый результат, а не оставлена на
 *    усмотрение вызывающего кода.
 */
export class AiProcessor {
  private readonly provider: AiProvider | null;
  private readonly heuristic: HeuristicAnalyzer;
  private readonly profanity: ProfanityGuard;

  constructor(
    private readonly config: AppConfig,
    categories: HeuristicCategory[],
    profanity?: ProfanityGuard,
    provider?: AiProvider,
  ) {
    this.heuristic = new HeuristicAnalyzer(categories);
    this.profanity = profanity ?? new ProfanityGuard();
    this.provider =
      provider ??
      (config.AI_PROVIDER === 'anthropic' ? new AnthropicProvider(config) : null);
  }

  get providerName(): string {
    return this.provider?.name ?? 'heuristic';
  }

  isAiAvailable(): boolean {
    return Boolean(this.provider?.isAvailable());
  }

  /** Быстрая классификация одной публикации. */
  async classifyPost(input: {
    text: string;
    sourceTitle: string;
    postedAt: string;
    categories: Array<{ slug: string; title: string }>;
  }): Promise<{ classification: AiPostClassification; producedBy: 'AI' | 'HEURISTIC' }> {
    if (!this.provider?.isAvailable()) {
      return { classification: this.heuristic.classifyPost(input), producedBy: 'HEURISTIC' };
    }

    // В модель уходит очищенная копия: исходные данные в БД не меняются.
    const { text } = this.profanity.prepareSourceTextForAi(input.text);

    try {
      const raw = await this.provider.complete({
        system: CLASSIFICATION_SYSTEM_PROMPT,
        user: buildClassificationUserMessage({ ...input, text }),
        maxTokens: 1024,
      });
      return { classification: parseClassification(raw), producedBy: 'AI' };
    } catch (error) {
      log.warn({ err: error }, 'Классификация моделью не удалась — используются правила');
      return { classification: this.heuristic.classifyPost(input), producedBy: 'HEURISTIC' };
    }
  }

  /**
   * Полный разбор события и подготовка черновика.
   *
   * Последовательность: очистка исходников → модель → валидация схемы →
   * проверка лексики → при необходимости повторная генерация → при
   * повторной неудаче очистка текста и пометка для модератора.
   */
  async analyzeEvent(input: EventAnalysisInput & {
    categories: Array<{ slug: string; title: string }>;
  }): Promise<AnalysisOutcome> {
    const warnings: string[] = [];

    // Слой 1 защиты (ТЗ §7.1): мат вырезается из копии, уходящей в модель.
    const preparedPosts = input.posts.map((post) => {
      const { text, hadProfanity } = this.profanity.prepareSourceTextForAi(post.text);
      if (hadProfanity) {
        warnings.push(`В публикации ${post.index} исходно присутствовала нецензурная лексика.`);
      }
      return { ...post, text };
    });

    const preparedTranscripts = input.transcripts.map((transcript) => ({
      ...transcript,
      text: this.profanity.prepareSourceTextForAi(transcript.text).text,
    }));

    let analysis: AiEventAnalysis | null = null;
    let producedBy: 'AI' | 'HEURISTIC' = 'HEURISTIC';
    let raw: unknown = null;

    if (this.provider?.isAvailable()) {
      const attempt = await this.callModel(
        preparedPosts,
        preparedTranscripts,
        input.categories,
        input.existingLocation ?? null,
      );
      if (attempt) {
        analysis = attempt.analysis;
        raw = attempt.raw;
        producedBy = 'AI';
      } else {
        warnings.push('Модель недоступна или вернула некорректный ответ — разбор выполнен по правилам.');
      }
    }

    if (!analysis) {
      analysis = this.heuristic.analyzeEvent({
        posts: preparedPosts,
        transcripts: preparedTranscripts,
      });
    }

    // Слой 3 защиты (ТЗ §7.3): проверка готового текста по всем полям.
    let report = this.checkAnalysis(analysis);
    let regenerated = false;

    if (!report.allowed && producedBy === 'AI' && this.provider?.isAvailable()) {
      // Одна повторная попытка с явным указанием на нарушение.
      log.warn({ reason: report.reason }, 'В черновике найдена запрещённая лексика — повторная генерация');
      regenerated = true;

      const retry = await this.callModel(
        preparedPosts,
        preparedTranscripts,
        input.categories,
        input.existingLocation ?? null,
        'В предыдущем ответе была обнаружена недопустимая лексика. ' +
          'Перефразируй нейтрально. Маскировать слова звёздочками нельзя.',
      );

      if (retry) {
        const retryReport = this.checkAnalysis(retry.analysis);
        if (retryReport.allowed) {
          analysis = retry.analysis;
          raw = retry.raw;
          report = retryReport;
        } else {
          warnings.push('Повторная генерация также содержала запрещённую лексику.');
        }
      }
    }

    // Слой 5 (ТЗ §7.5): если лексика осталась, текст очищается, а материал
    // помечается — публикация в таком виде будет заблокирована.
    if (!report.allowed) {
      const sanitized = this.profanity.sanitizeEditorialText(analysis.draft);
      analysis = {
        ...analysis,
        draft: sanitized.text,
        title: this.profanity.sanitizeEditorialText(analysis.title).text || 'Требуется ручная правка',
        summary: this.profanity.sanitizeEditorialText(analysis.summary).text,
        witnessQuotes: analysis.witnessQuotes.filter(
          (quote) => this.profanity.detectProfanity(quote.text).length === 0,
        ),
        // Уверенность обнуляется: материал заведомо требует человека.
        confidence: Math.min(analysis.confidence, 0.3),
      };
      report = this.checkAnalysis(analysis);
      warnings.push(
        sanitized.removedSentences.length > 0
          ? `Удалено предложений с недопустимой лексикой: ${sanitized.removedSentences.length}.`
          : 'Текст очищен от недопустимой лексики.',
      );
    }

    return {
      analysis,
      producedBy,
      model: producedBy === 'AI' ? (this.provider?.model ?? null) : null,
      profanityReport: report,
      regenerated,
      raw,
      warnings,
    };
  }

  /** Один вызов модели с разбором и валидацией схемы. */
  private async callModel(
    posts: EventAnalysisInput['posts'],
    transcripts: EventAnalysisInput['transcripts'],
    categories: Array<{ slug: string; title: string }>,
    existingLocation: string | null,
    extraInstruction?: string,
  ): Promise<{ analysis: AiEventAnalysis; raw: unknown } | null> {
    if (!this.provider) return null;

    const user =
      buildEditorialUserMessage({ posts, transcripts, categories, existingLocation }) +
      (extraInstruction ? `\n\n## Дополнительное требование\n${extraInstruction}\n` : '');

    try {
      const rawText = await this.provider.complete({
        system: EDITORIAL_SYSTEM_PROMPT,
        user,
      });
      const analysis = parseEventAnalysis(rawText);

      // Модель могла предложить категорию, которой нет в системе.
      const known = new Set(categories.map((c) => c.slug));
      if (!known.has(analysis.category)) {
        log.warn({ category: analysis.category }, 'Модель вернула неизвестную категорию');
        analysis.category = 'other';
      }

      return { analysis, raw: rawText };
    } catch (error) {
      if (error instanceof AiResponseError) {
        log.warn({ err: error.message }, 'Ответ модели не прошёл валидацию схемы');
      } else if (error instanceof AiUnavailableError) {
        log.warn({ err: error.message }, 'Модель недоступна');
      } else {
        log.error({ err: error }, 'Непредвиденная ошибка обращения к модели');
      }
      return null;
    }
  }

  /** Проверить ВСЕ текстовые поля результата (ТЗ §7.7). */
  private checkAnalysis(analysis: AiEventAnalysis): ProfanityReport {
    return this.profanity.validateEditorialText({
      title: analysis.title,
      summary: analysis.summary,
      body: analysis.draft,
      location: analysis.location,
      facts: analysis.facts.map((fact) => fact.text),
      uncertainties: analysis.uncertainties,
      sourceClaims: analysis.sourceClaims.map((claim) => claim.claim),
      quotes: analysis.witnessQuotes.map((quote) => quote.text),
    });
  }
}
