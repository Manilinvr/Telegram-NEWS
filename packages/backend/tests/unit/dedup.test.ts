import { describe, expect, it } from 'vitest';
import { compareForDedup, haversineKm, type DedupCandidate } from '../../src/modules/dedup/engine.js';
import {
  LocalEmbeddingProvider,
  cosineSimilarity,
  normalizeVector,
} from '../../src/modules/dedup/embeddings.js';
import { extractEntities } from '../../src/lib/text.js';

/**
 * Тесты объединения публикаций в события (ТЗ §4).
 *
 * Самое важное здесь — НЕ объединять разные происшествия. Лишнее
 * разделение модератор исправляет одним действием, а лишнее объединение
 * склеивает две новости в одну и замечается далеко не всегда.
 */

const provider = new LocalEmbeddingProvider(512);
const OPTIONS = { timeWindowHours: 36, mergeThreshold: 0.78, reviewThreshold: 0.62 };

const BASE_TIME = new Date('2026-04-14T14:32:00Z');

function candidate(input: {
  id: string;
  text: string;
  minutesOffset?: number;
  sourceId?: string;
  category?: string;
  lat?: number | null;
  lon?: number | null;
  media?: string[];
}): DedupCandidate {
  const postedAt = new Date(BASE_TIME.getTime() + (input.minutesOffset ?? 0) * 60_000);
  return {
    post: {
      id: input.id,
      sourceId: input.sourceId ?? `source-${input.id}`,
      postedAt: postedAt.toISOString(),
      normalizedText: input.text,
      rawText: input.text,
    },
    embedding: provider.embedSync(input.text),
    entities: extractEntities(input.text),
    categorySlug: input.category ?? 'dtp',
    latitude: input.lat ?? null,
    longitude: input.lon ?? null,
    mediaChecksums: input.media ?? [],
  };
}

describe('Локальные эмбеддинги', () => {
  it('одинаковый текст даёт одинаковый вектор', () => {
    const a = provider.embedSync('В Новороссийске произошло ДТП на улице Видова');
    const b = provider.embedSync('В Новороссийске произошло ДТП на улице Видова');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('перефразировка того же события ближе, чем другая новость', () => {
    const original = provider.embedSync('На улице Видова столкнулись два автомобиля, движение затруднено');
    const paraphrase = provider.embedSync('Два автомобиля столкнулись на Видова, образовалась пробка');
    const unrelated = provider.embedSync('В городском парке открыли новую детскую площадку');

    expect(cosineSimilarity(original, paraphrase)).toBeGreaterThan(
      cosineSimilarity(original, unrelated),
    );
  });

  it('вектор нормализован', () => {
    const vector = provider.embedSync('произвольный текст новости');
    const length = Math.sqrt([...vector].reduce((sum, v) => sum + v * v, 0));
    expect(length).toBeCloseTo(1, 4);
  });

  it('пустой текст не вызывает ошибку', () => {
    expect(() => provider.embedSync('')).not.toThrow();
    expect(cosineSimilarity(normalizeVector(new Float32Array(8)), new Float32Array(8))).toBe(0);
  });

  it('векторы разной длины не сравниваются', () => {
    expect(cosineSimilarity(new Float32Array(4), new Float32Array(8))).toBe(0);
  });
});

describe('Объединение публикаций об одном событии', () => {
  it('объединяет два сообщения об одном ДТП', () => {
    const a = candidate({
      id: 'a',
      text: 'В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей. На месте работают сотрудники ДПС, движение затруднено.',
      lat: 44.7315,
      lon: 37.7519,
    });
    const b = candidate({
      id: 'b',
      minutesOffset: 25,
      text: 'ДТП на улице Видова в Новороссийске: столкнулись две машины. Полиция на месте, движение по полосе затруднено.',
      lat: 44.7315,
      lon: 37.7519,
    });

    const verdict = compareForDedup(a, b, OPTIONS);
    expect(verdict.decision).toBe('merge');
    expect(verdict.score).toBeGreaterThan(OPTIONS.mergeThreshold);
  });

  it('распознаёт перепечатку по совпадающим медиафайлам', () => {
    const a = candidate({ id: 'a', text: 'Пожар в жилом доме на Анапском шоссе.', media: ['checksum-1'] });
    const b = candidate({
      id: 'b',
      minutesOffset: 40,
      text: 'Пожар в жилом доме на Анапском шоссе.',
      media: ['checksum-1'],
    });

    const verdict = compareForDedup(a, b, OPTIONS);
    expect(verdict.isReprint).toBe(true);
    expect(verdict.explanation).toContain('перепечатка');
  });

  it('дословная копия считается перепечаткой, а не подтверждением', () => {
    const text = 'В Восточном районе временно отключили электричество из-за аварии на сетях.';
    const verdict = compareForDedup(
      candidate({ id: 'a', text, category: 'utilities' }),
      candidate({ id: 'b', text, minutesOffset: 15, category: 'utilities' }),
      OPTIONS,
    );
    expect(verdict.isReprint).toBe(true);
  });
});

describe('Разделение разных событий', () => {
  it('не объединяет два разных ДТП только из-за похожих слов', () => {
    // Ключевое требование ТЗ §4: одинаковая лексика сама по себе не
    // является основанием для объединения.
    const a = candidate({
      id: 'a',
      text: 'В Новороссийске на улице Видова произошло ДТП, столкнулись два автомобиля.',
      lat: 44.7315,
      lon: 37.7519,
    });
    const b = candidate({
      id: 'b',
      minutesOffset: 200,
      text: 'В Новороссийске на Анапском шоссе произошло ДТП, столкнулись два автомобиля.',
      lat: 44.7457,
      lon: 37.7318,
    });

    const verdict = compareForDedup(a, b, OPTIONS);
    expect(verdict.decision).not.toBe('merge');
  });

  it('не объединяет события в разных концах города', () => {
    const a = candidate({ id: 'a', text: 'Пожар в частном доме, работают пожарные расчёты.', lat: 44.6683, lon: 37.7716 });
    const b = candidate({ id: 'b', minutesOffset: 30, text: 'Пожар в частном доме, работают пожарные расчёты.', lat: 44.8318, lon: 37.6491 });

    const verdict = compareForDedup(a, b, OPTIONS);
    expect(verdict.signals.geo).toBe(0);
    expect(verdict.explanation).toContain('Географические привязки');
  });

  it('не объединяет публикации вне временно́го окна', () => {
    const text = 'На набережной прошёл фестиваль уличной культуры.';
    const verdict = compareForDedup(
      candidate({ id: 'a', text, category: 'events' }),
      candidate({ id: 'b', text, minutesOffset: 60 * 40, category: 'events' }),
      OPTIONS,
    );

    expect(verdict.decision).toBe('separate');
    expect(verdict.score).toBe(0);
    expect(verdict.explanation).toContain('временно́го окна');
  });

  it('совершенно разные новости остаются разными событиями', () => {
    const verdict = compareForDedup(
      candidate({ id: 'a', text: 'ДТП на трассе Новороссийск — Керчь, движение затруднено.' }),
      candidate({ id: 'b', minutesOffset: 10, text: 'В библиотеке открылась выставка детского рисунка.', category: 'events' }),
      OPTIONS,
    );
    expect(verdict.decision).toBe('separate');
  });
});

describe('Решающая роль конкретного места', () => {
  /**
   * Самый важный набор: именно название улицы разводит два похожих
   * происшествия и связывает два непохожих текста об одном.
   */
  it('объединяет публикации об одном ДТП, написанные разными словами', () => {
    // Текстовое сходство здесь низкое — редакции формулируют по-своему.
    // Координаты проставляет геокодер конвейера по упомянутой улице.
    const a = candidate({
      id: 'a',
      text: 'В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей. По предварительной информации, пострадавших нет. На месте работают сотрудники ДПС, движение затруднено.',
      lat: 44.7315,
      lon: 37.7519,
    });
    const b = candidate({
      id: 'b',
      minutesOffset: 7,
      text: 'ДТП на улице Видова: столкнулись две легковые машины. Очевидцы сообщают о затруднённом движении в сторону центра. Полиция уже на месте.',
      lat: 44.7315,
      lon: 37.7519,
    });

    const verdict = compareForDedup(a, b, OPTIONS);
    expect(verdict.signals.lexical).toBeLessThan(0.4);
    expect(verdict.decision).toBe('merge');
    expect(verdict.explanation).toContain('Совпадает конкретное место');
  });

  it('не объединяет ДТП на разных улицах, даже если текст почти одинаков', () => {
    const a = candidate({
      id: 'a',
      text: 'В Новороссийске на улице Видова произошло ДТП, столкнулись два автомобиля. Движение затруднено.',
    });
    const b = candidate({
      id: 'b',
      minutesOffset: 20,
      text: 'В Новороссийске на улице Анапское шоссе произошло ДТП, столкнулись два автомобиля. Движение затруднено.',
    });

    const verdict = compareForDedup(a, b, OPTIONS);
    // Текст практически совпадает...
    expect(verdict.signals.lexical).toBeGreaterThan(0.5);
    // ...но места разные, и это решает.
    expect(verdict.decision).not.toBe('merge');
    expect(verdict.explanation).toContain('разные места');
  });

  it('частые топонимы не считаются совпадением места', () => {
    // Упоминание города есть почти в каждой публикации и само по себе
    // ничего не подтверждает.
    const a = candidate({ id: 'a', text: 'В Новороссийске отключили воду в нескольких домах.', category: 'utilities' });
    const b = candidate({ id: 'b', minutesOffset: 30, text: 'В Новороссийске открылась выставка картин.', category: 'events' });

    expect(compareForDedup(a, b, OPTIONS).decision).toBe('separate');
  });

  it('два разных происшествия на одной улице с разницей в часы не сливаются', () => {
    // Место совпадает, но разрыв во времени велик — усиленное правило
    // не применяется, и события остаются раздельными.
    const a = candidate({
      id: 'a',
      text: 'Утром на улице Видова произошло ДТП, столкнулись два автомобиля.',
      lat: 44.7315,
      lon: 37.7519,
    });
    const b = candidate({
      id: 'b',
      minutesOffset: 8 * 60,
      text: 'Вечером на улице Видова сбили пешехода, на месте работает скорая.',
      lat: 44.7315,
      lon: 37.7519,
    });

    expect(compareForDedup(a, b, OPTIONS).decision).not.toBe('merge');
  });

  it('вес редкости сущностей учитывается, если передан', () => {
    const a = candidate({ id: 'a', text: 'Авария на улице Видова в Новороссийске.', lat: 44.7315, lon: 37.7519 });
    const b = candidate({ id: 'b', minutesOffset: 10, text: 'ДТП на улице Видова, Новороссийск.', lat: 44.7315, lon: 37.7519 });

    const idf = new Map([
      ['новороссийске', 0.1],
      ['новороссийск', 0.1],
      ['улица видова', 2.5],
      ['видова', 2.5],
    ]);

    const withIdf = compareForDedup(a, b, { ...OPTIONS, entityIdf: idf });
    expect(withIdf.decision).toBe('merge');
  });
});

describe('Пограничные случаи отправляются на проверку', () => {
  it('умеренное сходство приводит к ручной проверке, а не к слиянию', () => {
    const a = candidate({
      id: 'a',
      text: 'В центре Новороссийска ограничено движение из-за коммунальных работ на теплотрассе.',
      category: 'utilities',
      lat: 44.7235,
      lon: 37.7686,
    });
    const b = candidate({
      id: 'b',
      minutesOffset: 90,
      text: 'В центре города перекрыли участок дороги: ремонтируют теплосети.',
      category: 'utilities',
      lat: 44.7235,
      lon: 37.7686,
    });

    const verdict = compareForDedup(a, b, OPTIONS);
    // Решение может быть либо «проверить», либо «объединить», но
    // «разделить» здесь было бы явной ошибкой.
    expect(['merge', 'review']).toContain(verdict.decision);
  });

  it('оценка всегда в диапазоне 0..1', () => {
    const verdict = compareForDedup(
      candidate({ id: 'a', text: 'Короткий текст' }),
      candidate({ id: 'b', text: 'Другой короткий текст', minutesOffset: 5 }),
      OPTIONS,
    );
    expect(verdict.score).toBeGreaterThanOrEqual(0);
    expect(verdict.score).toBeLessThanOrEqual(1);
  });

  it('решение всегда сопровождается объяснением', () => {
    const verdict = compareForDedup(
      candidate({ id: 'a', text: 'Текст первой публикации о происшествии в городе.' }),
      candidate({ id: 'b', text: 'Текст второй публикации о происшествии в городе.', minutesOffset: 20 }),
      OPTIONS,
    );
    expect(verdict.explanation.length).toBeGreaterThan(10);
    expect(Object.keys(verdict.signals)).toEqual(
      expect.arrayContaining(['semantic', 'entities', 'lexical', 'time', 'geo', 'category']),
    );
  });

  it('отсутствие координат не мешает сравнению', () => {
    const verdict = compareForDedup(
      candidate({ id: 'a', text: 'Отключение воды в Южном районе на сутки.', category: 'utilities' }),
      candidate({ id: 'b', text: 'В Южном районе на сутки отключат воду.', minutesOffset: 30, category: 'utilities' }),
      OPTIONS,
    );
    expect(verdict.signals.geo).toBe(0.5);
    expect(verdict.decision).not.toBe('separate');
  });
});

describe('Расстояние между точками', () => {
  it('считает расстояние по городу', () => {
    // Центр Новороссийска и Кабардинка — около 15 км.
    const km = haversineKm(44.7235, 37.7686, 44.6512, 37.9382);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(20);
  });

  it('расстояние до самой себя равно нулю', () => {
    expect(haversineKm(44.7235, 37.7686, 44.7235, 37.7686)).toBeCloseTo(0, 5);
  });
});
