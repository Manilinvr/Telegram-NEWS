/**
 * Нормализация текста перед поиском запрещённой лексики (ТЗ §7).
 *
 * Простой поиск точных слов бесполезен: мат обходят регистром, латиницей,
 * цифрами вместо букв, повторами, пробелами и символами внутри слова.
 * Здесь текст приводится к единому виду, а вместе с ним строится карта
 * позиций, чтобы в отчёте можно было показать ИСХОДНЫЙ фрагмент, а не
 * нормализованный — модератор должен видеть то, что реально написано.
 */

/**
 * Гомоглифы и распространённые замены → кириллица.
 *
 * Латиница отображается по визуальному и фонетическому сходству именно так,
 * как её используют при обходе фильтров: `xyй`, `6ля`, `п3дец`, `hуй`.
 */
const CHAR_MAP: Record<string, string> = {
  // --- латиница ---
  a: 'а', b: 'б', c: 'с', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'р',
  q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'ш', x: 'х',
  y: 'у', z: 'з',
  // --- цифры вместо букв ---
  '0': 'о', '1': 'и', '3': 'з', '4': 'ч', '6': 'б', '9': 'я',
  // --- символы вместо букв ---
  '@': 'а', $: 'с', '€': 'е', '£': 'л', '&': 'и',
  // --- греческие и прочие похожие ---
  α: 'а', ο: 'о', ε: 'е', ρ: 'р', τ: 'т', υ: 'у', χ: 'х', κ: 'к',
  ѕ: 'с', і: 'и', ј: 'й', ԁ: 'д', ѵ: 'в', һ: 'х', ӏ: 'л',
};

/** Невидимые символы, которыми разрывают слова. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁯﻿᠎]/;

/**
 * Символы-заполнители: ими заменяют букву (`х*й`, `п#здец`).
 * В шаблонах поиска они трактуются как «любая буква».
 */
export const FILLER_CHARS = '*#%^&+~';

/** Разделители, которыми растягивают слово: `х у й`, `х.у.й`, `б-л-я`. */
const SEPARATORS = /[\s.,\-_|/\\:;'"`´·•~^]+/;

export interface NormalizedText {
  /** Нормализованный текст: нижний регистр, кириллица, без невидимых знаков. */
  text: string;
  /** map[i] — индекс символа `text[i]` в исходной строке. */
  map: number[];
  /** Исходная строка. */
  source: string;
  /** Метка варианта нормализации — попадает в отладочные отчёты. */
  variant: string;
}

/** Общий проход нормализации с произвольной таблицей замен. */
function normalizeWith(
  source: string,
  table: Record<string, string>,
  variant: string,
  yoToE = true,
): NormalizedText {
  const out: string[] = [];
  const map: number[] = [];

  // Обход идёт по кодовым точкам, а не по единицам UTF-16: иначе символы
  // вне BMP (например, математические начертания букв) разрезаются на
  // половины суррогатной пары и не нормализуются. Индекс при этом
  // продвигается на реальную длину символа, чтобы карта позиций
  // указывала на правильное место в исходной строке.
  let index = 0;
  for (const raw of source) {
    const charIndex = index;
    index += raw.length;

    if (INVISIBLE.test(raw)) continue;

    // NFKD раскладывает составные символы; затем убираем диакритику,
    // чтобы буквы с надстрочными знаками не проходили мимо фильтра.
    const decomposed = raw.normalize('NFKD').replace(/\p{M}+/gu, '');
    if (decomposed.length === 0) continue;

    for (const part of decomposed) {
      const lower = part.toLowerCase();
      const mapped = table[lower] ?? (yoToE && lower === 'ё' ? 'е' : lower);
      out.push(mapped);
      map.push(charIndex);
    }
  }

  return { text: out.join(''), map, source, variant };
}

/**
 * Привести текст к канонической форме, сохранив карту позиций.
 *
 * Повторы символов НЕ схлопываются: вместо этого шаблоны поиска используют
 * квантификатор `+`. Так `хуууй` находится, а легитимные слова с двойными
 * буквами не искажаются и корректно проверяются по списку исключений.
 */
export function normalizeText(source: string): NormalizedText {
  return normalizeWith(source, CHAR_MAP, 'cyrillic');
}

/**
 * Вариант, в котором цифры трактуются как символы-заполнители, а не как
 * буквы.
 *
 * Одна и та же цифра используется двояко: в `п0дъезд` ноль заменяет «о»,
 * а в `х0й` — «у». Однозначно разрешить это нельзя, поэтому проверяются
 * оба прочтения: здесь цифра становится «любой буквой» и совпадает с
 * шаблонами, допускающими заполнитель.
 */
const CHAR_MAP_DIGIT_WILDCARD: Record<string, string> = {
  ...CHAR_MAP,
  '0': '*', '1': '*', '3': '*', '4': '*', '5': '*', '6': '*', '7': '*', '8': '*', '9': '*',
};

export function normalizeDigitsAsWildcard(source: string): NormalizedText {
  return normalizeWith(source, CHAR_MAP_DIGIT_WILDCARD, 'digit-wildcard');
}

/**
 * Альтернативная транслитерация латиницы.
 *
 * В `huy` конечная `y` означает «й», а в `xyй` та же буква означает «у».
 * Базовый вариант читает `y` как «у», этот — как «й»; проверяются оба,
 * поэтому обе записи распознаются.
 */
const CHAR_MAP_TRANSLIT: Record<string, string> = {
  ...CHAR_MAP,
  y: 'й', j: 'й', i: 'й', u: 'у', h: 'х', e: 'е', w: 'в',
};

export function normalizeTranslit(source: string): NormalizedText {
  return normalizeWith(source, CHAR_MAP_TRANSLIT, 'translit');
}

/**
 * Склеить растянутые одиночные буквы: `х у й` → `хуй`, `б.л.я.т.ь` → `блять`.
 *
 * Схлопываются только последовательности из трёх и более ОДИНОЧНЫХ букв,
 * разделённых разделителями. Это подпись намеренного обхода фильтра, тогда
 * как обычный текст («цех уйдёт») состоит из многобуквенных слов и не
 * затрагивается — иначе фильтр давал бы ложные срабатывания на стыках слов.
 */
export function collapseSpacedLetters(input: NormalizedText): NormalizedText {
  const { text, map, source, variant } = input;
  const letter = /[а-яa-z]/;
  const isSep = (ch: string) => SEPARATORS.test(ch);

  const out: string[] = [];
  const outMap: number[] = [];
  let i = 0;

  while (i < text.length) {
    // Пробуем прочитать цепочку «буква — разделитель — буква — ...».
    const run: number[] = [];
    let j = i;
    let letters = 0;

    while (j < text.length) {
      const ch = text[j] as string;
      if (!letter.test(ch)) break;
      // Следующий символ должен быть разделителем (или концом цепочки).
      const next = text[j + 1];
      run.push(j);
      letters += 1;
      if (next === undefined || !isSep(next)) {
        j += 1;
        break;
      }
      let k = j + 1;
      while (k < text.length && isSep(text[k] as string)) k += 1;
      // После разделителя обязана идти ровно одна буква, иначе это
      // обычный текст, а не растянутое слово.
      if (k >= text.length || !letter.test(text[k] as string)) {
        j += 1;
        break;
      }
      j = k;
    }

    if (letters >= 3 && run.length === letters) {
      // Проверяем, что перед цепочкой и после неё — не буквы.
      const before = i > 0 ? (text[i - 1] as string) : ' ';
      const afterIndex = j;
      const after = afterIndex < text.length ? (text[afterIndex] as string) : ' ';
      if (!letter.test(before) && !letter.test(after)) {
        for (const index of run) {
          out.push(text[index] as string);
          outMap.push(map[index] as number);
        }
        i = j;
        continue;
      }
    }

    out.push(text[i] as string);
    outMap.push(map[i] as number);
    i += 1;
  }

  return { text: out.join(''), map: outMap, source, variant: `${variant}+collapsed` };
}

/**
 * Разбить нормализованный текст на слова с позициями.
 * Символы-заполнители считаются частью слова: `х*й` — одно слово.
 */
export interface Token {
  word: string;
  start: number;
  end: number;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = new RegExp(`[а-яa-z0-9${escapeForClass(FILLER_CHARS)}]+`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function escapeForClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&');
}

/** Найти границы слова, внутри которого находится совпадение. */
export function wordAround(text: string, start: number, end: number): Token {
  const isWordChar = (ch: string | undefined) =>
    ch !== undefined && new RegExp(`[а-яa-z0-9${escapeForClass(FILLER_CHARS)}]`).test(ch);

  let left = start;
  while (left > 0 && isWordChar(text[left - 1])) left -= 1;
  let right = end;
  while (right < text.length && isWordChar(text[right])) right += 1;

  return { word: text.slice(left, right), start: left, end: right };
}

/**
 * Кириллические гомоглифы → латиница.
 *
 * Основная нормализация переводит латиницу в кириллицу, что необходимо для
 * русского мата, но разрушает английские слова. Поэтому англоязычная брань
 * проверяется по отдельному «латинскому» варианту: он ловит приёмы вроде
 * `fuсk`, где `с` подменена кириллической буквой.
 */
const CHAR_MAP_LATIN: Record<string, string> = {
  а: 'a', в: 'b', с: 'c', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o',
  р: 'p', т: 't', у: 'y', х: 'x', і: 'i', ѕ: 's', ј: 'j', ԁ: 'd',
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '@': 'a', $: 's',
};

export function normalizeToLatin(source: string): NormalizedText {
  return normalizeWith(source, CHAR_MAP_LATIN, 'latin', false);
}
