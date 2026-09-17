import { KNOWN_LOCATIONS, NOVOROSSIYSK_CENTER } from '@nnm/shared';
import { stemRussian } from './stemmer.js';

/**
 * Работа с текстом публикаций.
 *
 * Исходный текст источника никогда не изменяется — здесь строится только
 * его нормализованная копия для анализа, поиска и сравнения публикаций
 * между собой.
 */

/** Шаблоны рекламно-служебных «хвостов», мешающих сравнивать тексты. */
const BOILERPLATE = [
  /подпис(ывайтесь|ка)[^\n]*/gi,
  /наш\s+(телеграм|канал|тг)[^\n]*/gi,
  /прислать\s+новость[^\n]*/gi,
  /пишите\s+в\s+(бот|личку)[^\n]*/gi,
  /source:[^\n]*/gi,
  /читайте\s+(также|подробнее)[^\n]*/gi,
  /\bреклама\b[^\n]*/gi,
  /erid:?\s*\S+/gi,
];

const URL_PATTERN = /https?:\/\/\S+|t\.me\/\S+|vk\.com\/\S+/gi;
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu;
const HASHTAG_PATTERN = /#[\wА-Яа-яЁё_]+/g;
const MENTION_PATTERN = /@[A-Za-z0-9_]{3,}/g;

/**
 * Нормализовать текст для анализа и сравнения.
 *
 * Убираются ссылки, эмодзи, хештеги и рекламные хвосты: без этого две
 * публикации об одном событии могут оказаться «непохожими» просто из-за
 * разных подписей каналов.
 */
export function normalizeForAnalysis(input: string): string {
  let text = input;
  for (const pattern of BOILERPLATE) text = text.replace(pattern, ' ');
  text = text
    .replace(URL_PATTERN, ' ')
    .replace(HASHTAG_PATTERN, ' ')
    .replace(MENTION_PATTERN, ' ')
    .replace(EMOJI_PATTERN, ' ')
    .replace(/[«»"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/** Первое предложение — используется как запасной заголовок. */
export function firstSentence(input: string, maxLength = 180): string {
  const normalized = normalizeForAnalysis(input);
  const match = /^(.{10,}?[.!?])\s/.exec(`${normalized} `);
  const candidate = match?.[1] ?? normalized;
  return truncate(candidate, maxLength);
}

export function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  const cut = input.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Стоп-слова исключаются из сравнения: они есть почти в каждом тексте. */
const STOP_WORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да',
  'ты','к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от','меня','еще','нет',
  'о','из','ему','теперь','когда','даже','ну','вдруг','ли','если','уже','или','ни','быть','был',
  'него','до','вас','нибудь','опять','уж','вам','ведь','там','потом','себя','ничего','ей','может',
  'они','тут','где','есть','надо','ней','для','мы','тебя','их','чем','была','сам','чтоб','без',
  'будто','чего','раз','тоже','себе','под','будет','ж','тогда','кто','этот','того','потому','этого',
  'какой','совсем','ним','здесь','этом','один','почти','мой','тем','чтобы','нее','были','куда',
  'зачем','всех','никогда','можно','при','наконец','два','об','другой','хоть','после','над','больше',
  'тот','через','эти','нас','про','всего','них','какая','много','разве','три','эту','моя','впрочем',
  'свою','этой','перед','иногда','лучше','чуть','том','такой','им','более','всегда','конечно','всю',
  'между','также','этих','также','году','года','город','городе',
]);

/** Значимые слова текста — основа для сравнения по пересечению лексики. */
export function significantWords(input: string): string[] {
  return normalizeForAnalysis(input)
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s-]/gi, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

/**
 * Привести слово к основе.
 *
 * Используется алгоритм Snowball для русского языка (см. lib/stemmer.ts).
 * У него есть известное свойство: омонимичные окончания разбираются по
 * правилу, а не по смыслу, поэтому «автомобили» сокращается как глагольная
 * форма (сравните «ходили»). Для сравнения текстов это приемлемо —
 * сходство считается по множеству слов, а не по отдельному слову.
 */
export function stem(word: string): string {
  return stemRussian(word);
}

export function stemAll(words: string[]): string[] {
  return words.map(stem);
}

/**
 * Извлечь сущности: топонимы, улицы, организации.
 *
 * Эвристика, а не NER-модель: используется как быстрый сигнал для
 * дедупликации до обращения к AI и как запасной вариант, если AI недоступен.
 */
export function extractEntities(input: string): string[] {
  const text = normalizeForAnalysis(input);
  const entities = new Set<string>();

  // Улицы, проспекты, переулки и т. п. вместе с названием.
  // ВАЖНО: `\b` в JavaScript определён через [A-Za-z0-9_] и с кириллицей
  // не работает — граница между пробелом и русской буквой им НЕ считается.
  // Поэтому границы задаются явными проверками соседних символов.
  const streetPattern =
    /(?<![А-Яа-яЁёA-Za-z])(?:улиц[аеыу]|ул\.|проспект[а-я]*|пр-т|переул(?:ок|ке)|шоссе|набережн[а-я]+|площад[ьи]|бульвар[а-я]*|трасс[аеы])\s+([А-ЯЁ][А-Яа-яЁё-]+(?:\s+[А-ЯЁ][А-Яа-яЁё-]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = streetPattern.exec(text)) !== null) {
    if (match[1]) entities.add(match[1].trim());
  }

  // Известные ориентиры города. Сопоставление идёт по ОСНОВАМ слов:
  // «на набережной» должно находить ориентир «Набережная …», а точное
  // совпадение подстроки этого не даёт.
  const textStems = wordStems(text);
  for (const location of KNOWN_LOCATIONS) {
    if (matchesPhrase(textStems, location.name) ||
        location.aliases.some((alias) => matchesPhrase(textStems, alias))) {
      entities.add(location.name);
    }
  }

  // Слова с заглавной буквы не в начале предложения — вероятные имена
  // собственные и названия организаций.
  const properPattern = /(?<![.!?]\s)(?<![А-Яа-яЁёA-Za-z])([А-ЯЁ][А-Яа-яЁё]{3,})(?![А-Яа-яЁё])/gm;
  while ((match = properPattern.exec(text)) !== null) {
    const word = match[1];
    if (word && !STOP_WORDS.has(word.toLowerCase())) entities.add(word);
  }

  return [...entities].slice(0, 30);
}

/**
 * Сопоставить упомянутое место с координатами.
 *
 * Работает по локальному справочнику ориентиров: внешний геокодер не
 * используется, чтобы система оставалась приватной и не отправляла
 * содержимое новостей сторонним сервисам.
 */
export function geocodeLocation(
  locationText: string | null,
): { latitude: number; longitude: number; matched: string } | null {
  if (!locationText) return null;
  const lowered = locationText.toLowerCase();
  const stems = wordStems(locationText);

  for (const location of KNOWN_LOCATIONS) {
    if (
      matchesPhrase(stems, location.name) ||
      location.aliases.some((alias) => matchesPhrase(stems, alias))
    ) {
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        matched: location.name,
      };
    }
  }

  // Упоминание города без уточнения — ставим точку в центре.
  if (/новороссийск/i.test(lowered)) {
    return { ...NOVOROSSIYSK_CENTER, matched: 'Новороссийск' };
  }
  return null;
}

/** Коэффициент Жаккара по множествам основ слов. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Все слова текста, приведённые к основам (без отсева стоп-слов). */
export function wordStems(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s-]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(stem);
}

/**
 * Встречается ли фраза в тексте с точностью до словоформ.
 * Сравниваются последовательности основ, поэтому «набережной» находит
 * «Набережная Адмирала Серебрякова».
 */
export function matchesPhrase(textStems: string[], phrase: string): boolean {
  const target = wordStems(phrase);
  if (target.length === 0 || target.length > textStems.length) return false;

  outer: for (let i = 0; i + target.length <= textStems.length; i += 1) {
    for (let j = 0; j < target.length; j += 1) {
      if (textStems[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}
