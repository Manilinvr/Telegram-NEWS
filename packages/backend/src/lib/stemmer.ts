/**
 * Стеммер русского языка (алгоритм Snowball / Porter для русского).
 *
 * Нужен для сравнения публикаций между собой: «пожара», «пожаре» и «пожаром»
 * должны считаться одним словом, иначе два текста об одном событии выглядят
 * непохожими. Наивное отбрасывание окончаний по списку здесь не годится —
 * порядок проверки приводит к тому, что «автомобили» и «автомобилях»
 * сокращаются до разных основ.
 *
 * Реализация следует спецификации snowballstem.org/algorithms/russian.
 */

const VOWELS = 'аеиоуыэюя';

const PERFECTIVE_GERUND_1 = ['вшись', 'вши', 'в'];
const PERFECTIVE_GERUND_2 = ['ившись', 'ывшись', 'ивши', 'ывши', 'ив', 'ыв'];

const ADJECTIVE = [
  'ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой',
  'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею',
];

const PARTICIPLE_1 = ['ющ', 'нн', 'вш', 'ем', 'щ'];
const PARTICIPLE_2 = ['ивш', 'ывш', 'ующ'];

const REFLEXIVE = ['ся', 'сь'];

const VERB_1 = [
  'ешь', 'нно', 'ете', 'йте', 'ла', 'на', 'ли', 'ем', 'ло', 'но', 'ет', 'ют', 'ны', 'ть',
  'й', 'л', 'н',
];
const VERB_2 = [
  'ейте', 'уйте', 'ила', 'ыла', 'ена', 'ите', 'или', 'ыли', 'ило', 'ыло', 'ено', 'ует', 'уют',
  'ены', 'ить', 'ыть', 'ишь', 'ей', 'уй', 'ил', 'ыл', 'им', 'ым', 'ен', 'ят', 'ит', 'ыт', 'ую', 'ю',
];

const NOUN = [
  'иями', 'ями', 'ами', 'иям', 'ям', 'ием', 'ем', 'ам', 'ом', 'ах', 'иях', 'ях', 'ию', 'ью',
  'ия', 'ья', 'ев', 'ов', 'ие', 'ье', 'еи', 'ии', 'ией', 'ей', 'ой', 'ий', 'иям', 'а', 'е',
  'и', 'й', 'о', 'у', 'ы', 'ь', 'ю', 'я',
];

const SUPERLATIVE = ['ейше', 'ейш'];
const DERIVATIONAL = ['ость', 'ост'];

/** Начало области RV — всё, что после первой гласной. */
function rvStart(word: string): number {
  for (let i = 0; i < word.length; i += 1) {
    if (VOWELS.includes(word[i] as string)) return i + 1;
  }
  return word.length;
}

/** Начало области R2 — вложенная область после R1. */
function r2Start(word: string): number {
  let r1 = word.length;
  for (let i = 1; i < word.length; i += 1) {
    if (!VOWELS.includes(word[i] as string) && VOWELS.includes(word[i - 1] as string)) {
      r1 = i + 1;
      break;
    }
  }
  let r2 = word.length;
  for (let i = r1 + 1; i < word.length; i += 1) {
    if (!VOWELS.includes(word[i] as string) && VOWELS.includes(word[i - 1] as string)) {
      r2 = i + 1;
      break;
    }
  }
  return r2;
}

/** Найти самое длинное окончание из списка, начинающееся не раньше `from`. */
function findEnding(word: string, from: number, endings: string[]): string | null {
  let best: string | null = null;
  for (const ending of endings) {
    if (!word.endsWith(ending)) continue;
    if (word.length - ending.length < from) continue;
    if (!best || ending.length > best.length) best = ending;
  }
  return best;
}

function cut(word: string, ending: string): string {
  return word.slice(0, word.length - ending.length);
}

/**
 * Окончания «группы 1» допустимы только после а/я — так алгоритм отличает
 * настоящее окончание от совпадающего куска основы.
 */
function tryGroup1(word: string, from: number, endings: string[]): string | null {
  const ending = findEnding(word, from, endings);
  if (!ending) return null;
  const prev = word[word.length - ending.length - 1];
  if (prev !== 'а' && prev !== 'я') return null;
  return cut(word, ending);
}

export function stemRussian(input: string): string {
  let word = input.toLowerCase().replace(/ё/g, 'е');
  if (word.length <= 2) return word;
  if (!/^[а-я-]+$/.test(word)) return word;

  const rv = rvStart(word);
  const r2 = r2Start(word);

  // --- Шаг 1 -------------------------------------------------------------
  const gerund =
    tryGroup1(word, rv, PERFECTIVE_GERUND_1) ??
    (() => {
      const ending = findEnding(word, rv, PERFECTIVE_GERUND_2);
      return ending ? cut(word, ending) : null;
    })();

  if (gerund !== null) {
    word = gerund;
  } else {
    const reflexive = findEnding(word, rv, REFLEXIVE);
    if (reflexive) word = cut(word, reflexive);

    // Прилагательное или причастие + прилагательное.
    const adjective = findEnding(word, rv, ADJECTIVE);
    let handled = false;

    if (adjective) {
      let stem = cut(word, adjective);
      const participle =
        tryGroup1(stem, rv, PARTICIPLE_1) ??
        (() => {
          const ending = findEnding(stem, rv, PARTICIPLE_2);
          return ending ? cut(stem, ending) : null;
        })();
      if (participle !== null) stem = participle;
      word = stem;
      handled = true;
    }

    if (!handled) {
      const verb =
        tryGroup1(word, rv, VERB_1) ??
        (() => {
          const ending = findEnding(word, rv, VERB_2);
          return ending ? cut(word, ending) : null;
        })();
      if (verb !== null) {
        word = verb;
        handled = true;
      }
    }

    if (!handled) {
      const noun = findEnding(word, rv, NOUN);
      if (noun) word = cut(word, noun);
    }
  }

  // --- Шаг 2: убрать конечное «и» ----------------------------------------
  if (word.endsWith('и') && word.length - 1 >= rv) {
    word = word.slice(0, -1);
  }

  // --- Шаг 3: словообразовательный суффикс в R2 --------------------------
  const derivational = findEnding(word, r2, DERIVATIONAL);
  if (derivational) word = cut(word, derivational);

  // --- Шаг 4 --------------------------------------------------------------
  if (word.endsWith('нн')) {
    word = word.slice(0, -1);
  } else {
    const superlative = findEnding(word, rv, SUPERLATIVE);
    if (superlative) {
      word = cut(word, superlative);
      if (word.endsWith('нн')) word = word.slice(0, -1);
    } else if (word.endsWith('ь')) {
      word = word.slice(0, -1);
    }
  }

  return word;
}
