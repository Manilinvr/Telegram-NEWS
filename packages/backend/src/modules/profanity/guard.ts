import type { ProfanityMatch, ProfanityReport } from '@nnm/shared';
import {
  collapseSpacedLetters,
  normalizeDigitsAsWildcard,
  normalizeText as normalize,
  normalizeToLatin,
  normalizeTranslit,
  tokenize,
  wordAround,
  type NormalizedText,
} from './normalize.js';
import {
  ALL_RULES,
  CYRILLIC_RULES,
  GLOBAL_ALLOW,
  LATIN_SCRIPT_RULES,
  RULES_VERSION,
  type ProfanityRule,
} from './dictionary.js';

/**
 * ProfanityGuard (ТЗ §30).
 *
 * Обязательная часть pipeline. Модуль намеренно не имеет метода «выключить»:
 * уровень BLOCK (мат) не отключается никакой настройкой и никаким флагом из
 * интерфейса. Настраивать можно только политику по уровню WARN — грубой
 * брани и оскорблениям.
 *
 * Проверка многоуровневая:
 *   1) нормализация текста (регистр, гомоглифы, цифры вместо букв, невидимые
 *      символы, диакритика);
 *   2) поиск по корням в нормализованном тексте;
 *   3) повторный поиск по тексту со склеенными растянутыми буквами (`х у й`);
 *   4) поиск по «латинскому» варианту для англоязычной брани;
 *   5) поиск по склейкам соседних коротких токенов (`ху й`);
 *   6) снятие ложных срабатываний по списку исключений (проверка целого слова).
 */

export interface ProfanityPolicy {
  /**
   * Блокировать ли публикацию при находках уровня WARN
   * (грубая брань, оскорбления). Мат уровня BLOCK блокируется всегда.
   */
  blockOnWarn: boolean;
  /** Дополнительные запрещённые слова, добавленные владельцем. */
  extraBlockWords: string[];
  /** Дополнительные исключения, снимающие ложные срабатывания. */
  extraAllowWords: string[];
}

export const DEFAULT_POLICY: ProfanityPolicy = {
  blockOnWarn: true,
  extraBlockWords: [],
  extraAllowWords: [],
};

/** Поля редакционного материала, подлежащие проверке (ТЗ §7.7). */
export interface EditorialContent {
  title?: string | null;
  body?: string | null;
  summary?: string | null;
  captions?: string[];
  quotes?: string[];
  keyPhrases?: string[];
  telegramPreview?: string | null;
  [field: string]: string | string[] | null | undefined;
}

interface RawMatch {
  rule: ProfanityRule;
  start: number;
  end: number;
  matched: string;
  variant: NormalizedText;
}

export class ProfanityGuard {
  private readonly policy: ProfanityPolicy;
  private readonly extraBlockRules: ProfanityRule[];
  private readonly extraAllow: RegExp[];

  constructor(policy: Partial<ProfanityPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };

    // Пользовательские слова добавляются как отдельные правила уровня BLOCK.
    this.extraBlockRules = this.policy.extraBlockWords
      .map((word) => word.trim())
      .filter(Boolean)
      .map((word, index) => ({
        id: `custom.block.${index}`,
        severity: 'BLOCK' as const,
        description: `Пользовательское запрещённое слово: ${word}`,
        pattern: new RegExp(escapeRegExp(normalize(word).text)),
      }));

    this.extraAllow = this.policy.extraAllowWords
      .map((word) => word.trim())
      .filter(Boolean)
      .map((word) => new RegExp(escapeRegExp(normalize(word).text)));
  }

  /** Версия набора правил — фиксируется в каждом отчёте. */
  get rulesVersion(): string {
    return `${RULES_VERSION}+${this.extraBlockRules.length}`;
  }

  /**
   * Привести текст к канонической форме (ТЗ §30: normalizeText).
   * Возвращает строку, по которой ведётся поиск.
   */
  normalizeText(input: string): string {
    return normalize(input).text;
  }

  /**
   * Найти запрещённую лексику (ТЗ §30: detectProfanity).
   * Возвращает все совпадения с указанием исходного фрагмента и позиции.
   */
  detectProfanity(input: string, field?: string): ProfanityMatch[] {
    if (!input || input.trim() === '') return [];

    const cyrillicRules = [...CYRILLIC_RULES, ...this.extraBlockRules];

    // Один и тот же символ может означать разные буквы, поэтому текст
    // проверяется в нескольких прочтениях сразу. Совпадения затем
    // схлопываются по позиции в исходной строке, так что дубликатов
    // в отчёте не возникает.
    const base = normalize(input);
    const variants: Array<[NormalizedText, ProfanityRule[]]> = [
      [base, cyrillicRules],
      [collapseSpacedLetters(base), cyrillicRules],
      [normalizeDigitsAsWildcard(input), cyrillicRules],
      [normalizeTranslit(input), cyrillicRules],
      [normalizeToLatin(input), LATIN_SCRIPT_RULES],
      [collapseSpacedLetters(normalizeToLatin(input)), LATIN_SCRIPT_RULES],
    ];

    const raw: RawMatch[] = [
      ...variants.flatMap(([variant, rules]) => this.scan(variant, rules)),
      ...this.scanSplitTokens(base),
    ];

    // Совпадения из разных вариантов нормализации указывают на одни и те же
    // символы исходной строки — схлопываем по позиции в ИСХОДНОМ тексте.
    const seen = new Set<string>();
    const matches: ProfanityMatch[] = [];

    for (const item of raw) {
      const sourceStart = item.variant.map[item.start] ?? 0;
      const sourceEnd = (item.variant.map[item.end - 1] ?? sourceStart) + 1;
      const key = `${item.rule.id}:${sourceStart}:${sourceEnd}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({
        matched: item.matched,
        original: input.slice(sourceStart, sourceEnd),
        rule: item.rule.id,
        severity: item.rule.severity,
        start: sourceStart,
        end: sourceEnd,
        ...(field ? { field } : {}),
      });
    }

    return matches.sort((a, b) => a.start - b.start);
  }

  /** Применить правила к одному варианту нормализации. */
  private scan(variant: NormalizedText, rules: ProfanityRule[]): RawMatch[] {
    const found: RawMatch[] = [];
    if (variant.text === '') return found;

    for (const rule of rules) {
      const pattern = new RegExp(rule.pattern.source, `${stripGlobal(rule.pattern.flags)}g`);
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(variant.text)) !== null) {
        // Шаблоны с ведущим «(?:^|[^а-я])» захватывают лишний символ —
        // ориентируемся на группу захвата, если она есть.
        const captured = match[1];
        const offset = captured ? match[0].indexOf(captured) : 0;
        const start = match.index + offset;
        const text = captured ?? match[0];
        const end = start + text.length;

        if (text.length === 0) {
          pattern.lastIndex += 1;
          continue;
        }

        if (!this.isAllowed(variant.text, start, end, rule)) {
          found.push({ rule, start, end, matched: text, variant });
        }

        // Защита от бесконечного цикла на шаблонах нулевой длины.
        if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
      }
    }

    return found;
  }

  /**
   * Поиск мата, разорванного пробелом на короткие куски: `ху й`, `бл я дь`.
   *
   * Склеиваются только соседние КОРОТКИЕ токены (до 3 символов). Благодаря
   * этому «цех уйдёт» не превращается в срабатывание: слово «уйдёт» длиннее
   * порога, и склейка не рассматривается.
   */
  private scanSplitTokens(variant: NormalizedText): RawMatch[] {
    const tokens = tokenize(variant.text);
    const found: RawMatch[] = [];
    const blockRules = [...CYRILLIC_RULES, ...this.extraBlockRules].filter(
      (r) => r.severity === 'BLOCK',
    );

    for (let i = 0; i < tokens.length; i += 1) {
      for (let span = 2; span <= 4 && i + span <= tokens.length; span += 1) {
        const window = tokens.slice(i, i + span);
        if (window.some((t) => t.word.length > 3)) break;

        const joined = window.map((t) => t.word).join('');
        if (joined.length < 3 || joined.length > 12) continue;

        for (const rule of blockRules) {
          const pattern = new RegExp(rule.pattern.source, stripGlobal(rule.pattern.flags));
          const match = pattern.exec(joined);
          if (!match) continue;

          const captured = match[1] ?? match[0];
          if (captured.length === 0) continue;
          // Проверка исключений по склеенному слову целиком.
          if (this.isAllowed(joined, 0, joined.length, rule)) continue;

          const first = window[0] as { start: number };
          const last = window[window.length - 1] as { end: number };
          found.push({
            rule,
            start: first.start,
            end: last.end,
            matched: captured,
            variant,
          });
        }
      }
    }

    return found;
  }

  /** Проверить, не является ли совпадение частью разрешённого слова. */
  private isAllowed(text: string, start: number, end: number, rule: ProfanityRule): boolean {
    const { word } = wordAround(text, start, end);
    const candidates = [...(rule.allow ?? []), ...GLOBAL_ALLOW, ...this.extraAllow];
    return candidates.some((allow) => allow.test(word));
  }

  /**
   * Проверить редакционный текст (ТЗ §30: validateEditorialText).
   *
   * Проверяются ВСЕ поля будущего материала: заголовок, тело, подписи,
   * цитаты, ключевые фразы из видео и Telegram preview (ТЗ §7.7).
   */
  validateEditorialText(content: EditorialContent | string): ProfanityReport {
    const fields: Array<[string, string]> = [];

    if (typeof content === 'string') {
      fields.push(['text', content]);
    } else {
      for (const [field, value] of Object.entries(content)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            if (item) fields.push([`${field}[${index}]`, item]);
          });
        } else {
          fields.push([field, value]);
        }
      }
    }

    const matches = fields.flatMap(([field, value]) => this.detectProfanity(value, field));
    return this.buildReport(matches, fields.map(([, v]) => v).join('\n'));
  }

  /**
   * Финальная проверка непосредственно перед отправкой в Telegram
   * (ТЗ §30: validateBeforePublish, §12, §31).
   *
   * Выполняется ВСЕГДА, даже если текст уже проверялся: после ручного
   * редактирования содержимое могло измениться. Политика здесь всегда
   * строгая — это последний рубеж перед публикацией.
   */
  validateBeforePublish(content: EditorialContent | string): ProfanityReport {
    const strict = new ProfanityGuard({ ...this.policy, blockOnWarn: true });
    const report = strict.validateEditorialText(content);

    if (!report.allowed) {
      return {
        ...report,
        reason: `Публикация заблокирована финальной проверкой: ${report.reason}`,
      };
    }
    return report;
  }

  /**
   * Очистить текст (ТЗ §30: sanitizeEditorialText).
   *
   * Мат НЕ заменяется звёздочками: маскировка оставляет исходный смысл
   * читаемым и противоречит ТЗ §7.6. Вместо этого предложение с запрещённой
   * лексикой удаляется целиком, а материал помечается как требующий
   * повторной генерации — нейтральную переформулировку должен сделать AI
   * или человек, а не механическая замена символов.
   */
  sanitizeEditorialText(input: string): {
    text: string;
    removedSentences: string[];
    stillHasProfanity: boolean;
    matches: ProfanityMatch[];
  } {
    const matches = this.detectProfanity(input);
    if (matches.length === 0) {
      return { text: input, removedSentences: [], stillHasProfanity: false, matches: [] };
    }

    const sentences = splitSentences(input);
    const kept: string[] = [];
    const removed: string[] = [];

    for (const sentence of sentences) {
      const sentenceMatches = this.detectProfanity(sentence.text);
      const hasBlocking = sentenceMatches.some(
        (m) => m.severity === 'BLOCK' || (this.policy.blockOnWarn && m.severity === 'WARN'),
      );
      if (hasBlocking) {
        removed.push(sentence.text.trim());
      } else {
        kept.push(sentence.text);
      }
    }

    const text = kept.join('').replace(/\n{3,}/g, '\n\n').trim();
    const residual = this.detectProfanity(text);

    return {
      text,
      removedSentences: removed,
      stillHasProfanity: residual.length > 0,
      matches,
    };
  }

  /**
   * Подготовить ИСХОДНЫЙ текст источника перед передачей в AI (ТЗ §7.1).
   *
   * Сырые данные в БД остаются нетронутыми — очищается только копия,
   * уходящая в модель, чтобы снизить вероятность того, что мат будет
   * воспроизведён в черновике.
   */
  prepareSourceTextForAi(input: string): { text: string; hadProfanity: boolean } {
    const matches = this.detectProfanity(input);
    if (matches.length === 0) return { text: input, hadProfanity: false };

    // Заменяем найденные фрагменты нейтральным маркером, сохраняя структуру
    // предложения: модель видит, что здесь была брань, но не саму брань.
    let result = '';
    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor) continue;
      result += input.slice(cursor, match.start) + '[нецензурно]';
      cursor = match.end;
    }
    result += input.slice(cursor);

    return { text: result, hadProfanity: true };
  }

  private buildReport(matches: ProfanityMatch[], normalizedSource: string): ProfanityReport {
    const blocking = matches.filter(
      (m) => m.severity === 'BLOCK' || (this.policy.blockOnWarn && m.severity === 'WARN'),
    );

    const allowed = blocking.length === 0;
    let reason: string;

    if (allowed) {
      reason =
        matches.length === 0
          ? 'Запрещённая лексика не обнаружена.'
          : `Обнаружено предупреждений: ${matches.length}, блокировка не требуется по текущей политике.`;
    } else {
      const details = blocking
        .slice(0, 10)
        .map((m) => `«${m.original}» (${m.rule}${m.field ? `, поле: ${m.field}` : ''})`)
        .join(', ');
      reason = `Обнаружена запрещённая лексика (${blocking.length}): ${details}`;
    }

    return {
      allowed,
      matches,
      reason,
      normalizedText: normalize(normalizedSource).text,
      rulesVersion: this.rulesVersion,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Разбить текст на предложения, сохраняя разделители. */
function splitSentences(input: string): Array<{ text: string }> {
  const parts = input.split(/(?<=[.!?…])\s+|(?<=\n)/);
  return parts.filter((p) => p.length > 0).map((text) => ({ text }));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripGlobal(flags: string): string {
  return flags.replace(/g/g, '');
}

/** Экземпляр по умолчанию для мест, где политика не настраивается. */
export const defaultProfanityGuard = new ProfanityGuard();

export { ALL_RULES, RULES_VERSION };
