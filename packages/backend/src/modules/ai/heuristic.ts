import type { AiEventAnalysis, AiPostClassification, Importance } from '@nnm/shared';
import { FALLBACK_CATEGORY_SLUG } from '@nnm/shared';
import { extractEntities, firstSentence, normalizeForAnalysis, stripPromotional, truncate, wordStems, matchesPhrase } from '../../lib/text.js';

/**
 * Эвристический анализатор.
 *
 * Выполняет ту же работу, что и модель, но по правилам. Нужен в двух
 * ситуациях, и обе — рабочие, а не «заглушечные»:
 *
 *  1. Развёртывание без ключа AI: система остаётся полностью
 *     работоспособной — публикации собираются, объединяются в события и
 *     получают черновик, который редактирует человек.
 *  2. Недоступность модели: вместо остановки pipeline материал получает
 *     базовый разбор, помечается низкой уверенностью и уходит на ручную
 *     проверку (ТЗ §24).
 *
 * Результат намеренно консервативен: эвристика не «додумывает» и ставит
 * низкий confidence, чтобы материал гарантированно попал к человеку.
 */

export interface HeuristicCategory {
  slug: string;
  title: string;
  keywords: string[];
  defaultImportance: Importance;
}

/** Слова, указывающие на предположение, а не на установленный факт. */
const ASSUMPTION_MARKERS = [
  'предположительно', 'по предварительным данным', 'предварительно', 'возможно',
  'вероятно', 'по некоторым данным', 'не исключено', 'по неподтверждённым',
  'по неподтвержденным', 'уточняется', 'выясняются', 'выясняется',
];

/** Слова, указывающие на источник сведений. */
const ATTRIBUTION_MARKERS: Array<[RegExp, string]> = [
  [/по\s+словам\s+очевидц\w*/i, 'по словам очевидца'],
  [/очевидц\w*\s+(?:рассказ\w+|сообщ\w+|говор\w+)/i, 'по словам очевидца'],
  [/по\s+данным\s+([а-яё\s]{3,40})/i, 'по данным источника'],
  [/как\s+сообщ\w+/i, 'как сообщает источник'],
  [/в\s+пресс-службе\s+сообщ\w+/i, 'по сообщению пресс-службы'],
  [/по\s+информации\s+([а-яё\s]{3,40})/i, 'по информации источника'],
];

/** Признаки высокой важности независимо от категории. */
const SEVERITY_MARKERS: Array<[RegExp, Importance]> = [
  [/погиб\w*|смертельн\w*|жертв\w*/i, 'CRITICAL'],
  [/эвакуац\w*|массов\w*\s+отравлен\w*|обрушен\w*/i, 'CRITICAL'],
  [/пострадав\w*|ранен\w*|госпитализ\w*/i, 'HIGH'],
  [/перекрыт\w*|заблокирован\w*|отключен\w*/i, 'HIGH'],
];

/** Публикации, которые новостью не являются. */
const NON_NEWS_MARKERS = [
  /^\s*реклама\b/i,
  /erid\s*:/i,
  /подпис\w+\s+на\s+(наш|канал)/i,
  /^\s*опрос\b/i,
  /с\s+днём\s+рождения/i,
  /розыгрыш\w*\s+приз/i,
];

export class HeuristicAnalyzer {
  constructor(private readonly categories: HeuristicCategory[]) {}

  classifyPost(input: { text: string; sourceTitle: string; postedAt: string }): AiPostClassification {
    const text = normalizeForAnalysis(input.text);
    const category = this.pickCategory(text);
    const importance = this.pickImportance(text, category.defaultImportance);

    return {
      category: category.slug,
      importance,
      isNews: !NON_NEWS_MARKERS.some((pattern) => pattern.test(text)) && text.length >= 30,
      location: this.extractLocation(text),
      headline:
        truncate(stripPromotional(firstSentence(text) || text), 200) || 'Публикация без текста',
      entities: extractEntities(input.text),
      // Уверенность эвристики заведомо ниже, чем у модели: материал
      // должен пройти через человека.
      confidence: 0.45,
    };
  }

  analyzeEvent(input: {
    posts: Array<{ index: number; sourceTitle: string; postedAt: string; text: string; url: string | null }>;
    transcripts: Array<{ mediaLabel: string; text: string }>;
  }): AiEventAnalysis {
    // За основу берём самую подробную публикацию: в ней больше фактов.
    const primary = [...input.posts].sort((a, b) => b.text.length - a.text.length)[0];
    if (!primary) {
      throw new Error('Для анализа не передано ни одной публикации');
    }

    const text = normalizeForAnalysis(primary.text);
    const category = this.pickCategory(text);
    const importance = this.pickImportance(text, category.defaultImportance);
    const location = this.extractLocation(text);

    const facts = this.extractFacts(input.posts);
    const uncertainties = this.extractUncertainties(input.posts);

    // Из чужого поста в наш черновик не должны попадать ссылки, упоминания
    // каналов и призывы подписаться.
    const clean = stripPromotional(text);
    const title = truncate(firstSentence(clean) || clean, 180) || 'Событие без заголовка';
    // Предел текста новости. 1024 символа — это ограничение Telegram на
    // подпись к фотографии, а не на сообщение: в обычном сообщении
    // помещается 4096. Публикатор сам решает, как отправить длинный
    // текст с вложением, поэтому здесь предел выбирается по содержанию,
    // а не по ограничению подписи.
    const summary = truncate(clean, 1500);

    const witnessQuotes = input.transcripts
      .flatMap((transcript) => this.pickQuotes(transcript.text))
      .slice(0, 3)
      .map((quote) => ({ text: quote, timecode: null, speaker: null }));

    const draft = buildDraftText({
      title,
      body: summary,
      location,
      eventTime: primary.postedAt,
      witnessQuotes: witnessQuotes.map((q) => q.text),
    });

    return {
      title,
      summary,
      category: category.slug,
      importance,
      location,
      eventTime: primary.postedAt,
      facts,
      uncertainties,
      sourceClaims: input.posts.map((post) => ({
        claim: truncate(stripPromotional(firstSentence(post.text) || post.text), 400),
        sourceIndex: post.index,
        attribution: detectAttribution(post.text),
      })),
      witnessQuotes,
      draft,
      // Низкая уверенность — сигнал модератору, что разбор сделан
      // правилами, а не моделью.
      confidence: 0.4,
    };
  }

  private pickCategory(text: string): HeuristicCategory {
    const stems = wordStems(text);
    let best: { category: HeuristicCategory; hits: number } | null = null;

    for (const category of this.categories) {
      let hits = 0;
      for (const keyword of category.keywords) {
        if (matchesPhrase(stems, keyword)) hits += 1;
      }
      if (hits > 0 && (!best || hits > best.hits)) best = { category, hits };
    }

    return (
      best?.category ??
      this.categories.find((c) => c.slug === FALLBACK_CATEGORY_SLUG) ?? {
        slug: FALLBACK_CATEGORY_SLUG,
        title: 'Другое',
        keywords: [],
        defaultImportance: 'LOW' as Importance,
      }
    );
  }

  private pickImportance(text: string, fallback: Importance): Importance {
    for (const [pattern, importance] of SEVERITY_MARKERS) {
      if (pattern.test(text)) return importance;
    }
    return fallback;
  }

  private extractLocation(text: string): string | null {
    const entities = extractEntities(text);
    return entities[0] ?? null;
  }

  /**
   * Факты — это предложения исходного текста.
   *
   * Эвристика не переформулирует: она отмечает, какое утверждение является
   * предположением и откуда оно взято. Придумывать новые формулировки без
   * модели было бы риском исказить смысл.
   */
  private extractFacts(
    posts: Array<{ index: number; text: string }>,
  ): AiEventAnalysis['facts'] {
    const facts: AiEventAnalysis['facts'] = [];
    const seen = new Set<string>();

    for (const post of posts) {
      for (const sentence of splitSentences(normalizeForAnalysis(post.text))) {
        if (sentence.length < 20 || sentence.length > 500) continue;
        const key = sentence.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);

        facts.push({
          text: sentence,
          // Подтверждённым считаем только то, что встретилось более чем
          // в одной публикации, — определяется позже, на уровне события.
          confirmed: false,
          assumption: ASSUMPTION_MARKERS.some((marker) => sentence.toLowerCase().includes(marker)),
          attribution: detectAttribution(sentence),
          sourceIndex: post.index,
        });
        if (facts.length >= 12) return facts;
      }
    }
    return facts;
  }

  private extractUncertainties(posts: Array<{ text: string }>): string[] {
    const result: string[] = [];
    for (const post of posts) {
      for (const sentence of splitSentences(normalizeForAnalysis(post.text))) {
        if (ASSUMPTION_MARKERS.some((marker) => sentence.toLowerCase().includes(marker))) {
          result.push(truncate(sentence, 300));
        }
      }
    }
    if (result.length === 0) {
      result.push('Сведения получены из открытых источников и требуют проверки.');
    }
    return [...new Set(result)].slice(0, 5);
  }

  /** Осмысленные реплики из транскрипции: достаточно длинные и разборчивые. */
  private pickQuotes(transcript: string): string[] {
    return splitSentences(transcript)
      .filter((sentence) => sentence.length >= 25 && sentence.length <= 300)
      .filter((sentence) => !sentence.includes('[неразборчиво]'))
      .slice(0, 2);
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function detectAttribution(text: string): string | null {
  for (const [pattern, label] of ATTRIBUTION_MARKERS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Собрать текст Telegram-поста (ТЗ §11).
 *
 * Ссылки и служебные данные здесь не добавляются: они живут в админке,
 * а строка «Источник» подставляется публикатором из фактических
 * источников события.
 */
export function buildDraftText(input: {
  title: string;
  body: string;
  location: string | null;
  eventTime: string | null;
  witnessQuotes: string[];
}): string {
  const lines: string[] = [input.title.toUpperCase(), '', input.body];

  if (input.location) {
    lines.push('', `📍 ${input.location}`);
  }
  if (input.eventTime) {
    const time = new Date(input.eventTime);
    if (!Number.isNaN(time.getTime())) {
      lines.push(
        `🕒 ${time.toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Moscow',
        })}`,
      );
    }
  }
  if (input.witnessQuotes.length > 0) {
    lines.push('', `🎥 Что говорят очевидцы: ${input.witnessQuotes.join(' … ')}`);
  }

  return lines.join('\n').trim();
}
