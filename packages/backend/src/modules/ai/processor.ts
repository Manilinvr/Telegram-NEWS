import {
  DEFAULT_EDITORIAL_STYLE,
  type AiEventAnalysis,
  type AiPostClassification,
  type EditorialStyle,
  type ProfanityReport,
} from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { ProfanityGuard } from '../profanity/index.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
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
  buildEditorialSystemPrompt,
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
  /**
   * Чем именно закончилось обращение к модели, если оно не удалось.
   * Нужно, чтобы в журнале стояла причина, а не «что-то пошло не так».
   */
  failure: ModelFailure | null;
}

/** Неудачное обращение к модели с причиной. */
export interface ModelFailure {
  ok: false;
  kind: 'unavailable' | 'schema' | 'unknown';
  reason: string;
}

type ModelAttempt = { ok: true; analysis: AiEventAnalysis; raw: unknown } | ModelFailure;

/** Причина отказа словами — для журнала и интерфейса. */
export function describeFailure(failure: ModelFailure): string {
  if (failure.kind === 'schema') {
    return `Ответ модели не соответствует ожидаемой структуре: ${failure.reason}`;
  }
  if (failure.kind === 'unavailable') {
    return `Модель не ответила: ${failure.reason}`;
  }
  return `Сбой обращения к модели: ${failure.reason}`;
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
  private style: EditorialStyle = DEFAULT_EDITORIAL_STYLE;
  /**
   * Тратить ли запрос на классификацию публикации.
   *
   * Выключается ради бесплатных тарифов, где считаются запросы в сутки:
   * классификация — половина всех обращений, и правила её выполняют,
   * пусть и грубее. Переписывание текста правилами не заменяется ничем,
   * поэтому черновики этот флаг не затрагивает.
   */
  private modelForClassification = true;

  constructor(
    private readonly config: AppConfig,
    categories: HeuristicCategory[],
    profanity?: ProfanityGuard,
    provider?: AiProvider,
  ) {
    this.heuristic = new HeuristicAnalyzer(categories);
    this.profanity = profanity ?? new ProfanityGuard();
    this.provider = provider ?? makeProvider(config);
  }

  /**
   * Задать редакционный стиль из настроек.
   *
   * Отдельным вызовом, а не параметром конструктора: стиль нужен только
   * при подготовке черновика, а классификация и проверка связи обходятся
   * без него — иначе каждое место создания процессора было бы обязано
   * ходить в базу за настройкой, которая ему не нужна.
   */
  setStyle(style: EditorialStyle): this {
    this.style = style;
    return this;
  }

  setModelForClassification(enabled: boolean): this {
    this.modelForClassification = enabled;
    return this;
  }

  get editorialStyle(): EditorialStyle {
    return this.style;
  }

  get providerName(): string {
    return this.provider?.name ?? 'heuristic';
  }

  isAiAvailable(): boolean {
    return Boolean(this.provider?.isAvailable());
  }

  /**
   * Почему модель не используется — словами, а не флагом.
   *
   * Настройка модели делается переменными окружения на хостинге, где
   * опечатку не видно: система продолжает работать по правилам и внешне
   * выглядит исправной. Причина поэтому называется явно.
   */
  unavailableReason(): string | null {
    if (this.config.AI_PROVIDER === 'mock') {
      return 'AI_PROVIDER=mock — разбор идёт по правилам, модель не подключена.';
    }
    if (this.config.AI_PROVIDER === 'anthropic' && !this.config.ANTHROPIC_API_KEY) {
      return 'Не задан ANTHROPIC_API_KEY.';
    }
    if (this.config.AI_PROVIDER === 'openai-compatible' && !this.config.AI_BASE_URL) {
      return 'Не задан AI_BASE_URL — адрес службы с интерфейсом OpenAI.';
    }
    return this.provider?.isAvailable() ? null : 'Провайдер модели недоступен.';
  }

  /**
   * Живая проверка связи с моделью.
   *
   * Отличается от `isAiAvailable` принципиально: там проверяется только
   * наличие настроек, здесь — что служба отвечает этим ключом и знает эту
   * модель. Неверный ключ, исчерпанный лимит и опечатка в названии модели
   * видны лишь в ответе службы, а иначе обнаруживались бы молча — разбором
   * по правилам вместо модели.
   */
  async check(): Promise<{ ok: boolean; provider: string; model: string | null; reason?: string; ms?: number }> {
    const reason = this.unavailableReason();
    if (reason || !this.provider) {
      return {
        ok: false,
        provider: this.providerName,
        model: this.provider?.model ?? null,
        reason: reason ?? 'Провайдер модели не настроен.',
      };
    }

    const started = Date.now();
    try {
      const answer = await this.provider.complete({
        system: 'Отвечай одним словом.',
        user: 'Ответь словом: готово',
        maxTokens: 16,
      });
      return {
        ok: answer.trim().length > 0,
        provider: this.provider.name,
        model: this.provider.model,
        ms: Date.now() - started,
        ...(answer.trim().length > 0 ? {} : { reason: 'Служба вернула пустой ответ.' }),
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.provider.name,
        model: this.provider.model,
        ms: Date.now() - started,
        reason: (error as Error).message,
      };
    }
  }

  /** Быстрая классификация одной публикации. */
  async classifyPost(input: {
    text: string;
    sourceTitle: string;
    postedAt: string;
    categories: Array<{ slug: string; title: string }>;
  }): Promise<{ classification: AiPostClassification; producedBy: 'AI' | 'HEURISTIC' }> {
    if (!this.modelForClassification || !this.provider?.isAvailable()) {
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
    let failure: ModelFailure | null = null;

    if (this.provider?.isAvailable()) {
      const attempt = await this.callModel(
        preparedPosts,
        preparedTranscripts,
        input.categories,
        input.existingLocation ?? null,
      );
      if (attempt.ok) {
        analysis = attempt.analysis;
        raw = attempt.raw;
        producedBy = 'AI';
      } else {
        failure = attempt;
        warnings.push(describeFailure(attempt));
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

      if (retry.ok) {
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
      failure,
    };
  }

  /**
   * Один вызов модели с разбором и валидацией схемы.
   *
   * При неудаче возвращается причина, а не просто null: «модель не
   * ответила» и «ответ не по схеме» — разные неполадки с разными
   * действиями, и раньше их было не отличить ни в журнале, ни в
   * интерфейсе.
   */
  private async callModel(
    posts: EventAnalysisInput['posts'],
    transcripts: EventAnalysisInput['transcripts'],
    categories: Array<{ slug: string; title: string }>,
    existingLocation: string | null,
    extraInstruction?: string,
  ): Promise<ModelAttempt> {
    if (!this.provider) {
      return { ok: false, kind: 'unavailable', reason: 'Провайдер модели не настроен.' };
    }

    const user =
      buildEditorialUserMessage({ posts, transcripts, categories, existingLocation }) +
      (extraInstruction ? `\n\n## Дополнительное требование\n${extraInstruction}\n` : '');

    try {
      const rawText = await this.provider.complete({
        system: buildEditorialSystemPrompt(this.style),
        user,
      });
      const analysis = parseEventAnalysis(rawText);

      // Модель могла предложить категорию, которой нет в системе.
      const known = new Set(categories.map((c) => c.slug));
      if (!known.has(analysis.category)) {
        log.warn({ category: analysis.category }, 'Модель вернула неизвестную категорию');
        analysis.category = 'other';
      }

      return { ok: true, analysis, raw: rawText };
    } catch (error) {
      const message = (error as Error).message;

      if (error instanceof AiResponseError) {
        log.warn({ err: message }, 'Ответ модели не прошёл валидацию схемы');
        return { ok: false, kind: 'schema', reason: message };
      }
      if (error instanceof AiUnavailableError) {
        log.warn({ err: message }, 'Модель недоступна');
        return { ok: false, kind: 'unavailable', reason: message };
      }
      log.error({ err: error }, 'Непредвиденная ошибка обращения к модели');
      return { ok: false, kind: 'unknown', reason: message };
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

/** Выбор провайдера по конфигурации. */
function makeProvider(config: AppConfig): AiProvider | null {
  switch (config.AI_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(config);
    default:
      // mock — разбор по правилам, без обращения к модели.
      return null;
  }
}
