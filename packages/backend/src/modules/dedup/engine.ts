import type { SourcePost } from '@nnm/shared';
import { KNOWN_LOCATIONS } from '@nnm/shared';
import { jaccardSimilarity, significantWords, stemAll, wordStems } from '../../lib/text.js';
import { cosineSimilarity } from './embeddings.js';

/**
 * Определение того, описывают ли две публикации одно событие (ТЗ §4).
 *
 * Решение принимается по нескольким независимым признакам, а не по одному
 * числу. Ключевое требование ТЗ — НЕ объединять новости только потому, что
 * в них совпали слова: два разных ДТП в один день описываются почти
 * одинаковой лексикой. Поэтому лексическое сходство само по себе слияния
 * не вызывает, а служит лишь одним из голосов.
 */

export interface DedupSignals {
  /** Близость векторных представлений текстов. */
  semantic: number;
  /** Пересечение извлечённых сущностей (топонимы, организации). */
  entities: number;
  /** Пересечение значимой лексики. */
  lexical: number;
  /** Близость по времени публикации. */
  time: number;
  /** Совпадение географической привязки. */
  geo: number;
  /** Совпадение категории. */
  category: number;
}

export interface DedupVerdict {
  score: number;
  decision: 'merge' | 'review' | 'separate';
  signals: DedupSignals;
  /**
   * Является ли вторая публикация перепечаткой первой, а не независимым
   * подтверждением. Влияет на уровень подтверждённости события (ТЗ §28).
   */
  isReprint: boolean;
  /** Человекочитаемое объяснение — показывается модератору. */
  explanation: string;
}

export interface DedupCandidate {
  post: Pick<SourcePost, 'id' | 'sourceId' | 'postedAt' | 'normalizedText' | 'rawText'>;
  embedding: Float32Array | number[] | null;
  entities: string[];
  categorySlug: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Контрольные суммы медиа — совпадение указывает на перепечатку. */
  mediaChecksums?: string[];
}

export interface DedupOptions {
  /** Окно поиска кандидатов в часах. */
  timeWindowHours: number;
  /** Порог, выше которого публикации объединяются автоматически. */
  mergeThreshold: number;
  /** Порог, выше которого решение отправляется на ручную проверку. */
  reviewThreshold: number;
  /**
   * Вес редкости сущностей, посчитанный по окну кандидатов.
   *
   * Упоминание «Новороссийск» есть почти в каждой публикации и не несёт
   * информации, а «улица Видова» встречается редко и потому является
   * сильной уликой. Без этой поправки частые слова размывают совпадение.
   */
  entityIdf?: Map<string, number>;
}

/**
 * Привести сущность к сравнимому виду.
 *
 * Сущности сравниваются по ОСНОВАМ слов, а не как строки: «Восточном» и
 * «Восточного» — одно и то же место, и при посимвольном сравнении они
 * никогда не совпадут. Без этой нормализации совпадение мест у двух
 * публикаций об одном событии систематически занижалось.
 */
export function normalizeEntity(entity: string): string {
  return wordStems(entity).join(' ');
}

/** Слова, по которым сущность распознаётся как конкретное место. */
const PLACE_MARKERS = /улиц|шоссе|проспект|переул|набережн|площад|бульвар|трасс|микрорайон/i;

/** Топонимы уровня города и края: они есть везде и ничего не различают. */
const GENERIC_PLACES = /^(новороссийск|краснодар|кубань|россия|город)/i;

/**
 * Выделить из набора сущностей КОНКРЕТНЫЕ места.
 *
 * Именно они разводят похожие происшествия: два ДТП в один день
 * описываются почти одинаковыми словами и отличаются, по сути, только
 * названием улицы.
 */
function specificPlaces(entities: string[]): Set<string> {
  const places = new Set<string>();
  for (const entity of entities) {
    const value = entity.toLowerCase().trim();
    if (!value || GENERIC_PLACES.test(value)) continue;

    const normalized = normalizeEntity(entity);
    if (!normalized) continue;

    const isKnownLandmark = KNOWN_LOCATIONS.some(
      (location) =>
        normalizeEntity(location.name) === normalized ||
        location.aliases.some((alias) => normalizeEntity(alias) === normalized),
    );
    if (isKnownLandmark || PLACE_MARKERS.test(value)) {
      places.add(normalized);
    }
  }
  return places;
}

/**
 * Совпадение сущностей с поправкой на редкость.
 *
 * Используется коэффициент перекрытия (|A∩B| / min(|A|,|B|)), а не
 * Жаккар: для вопроса «одно ли это событие» важно, пересекаются ли
 * упомянутые места, а не совпадают ли наборы целиком. Одна публикация
 * может дополнительно упомянуть район или ведомство, и симметричная мера
 * несправедливо занижала бы сходство.
 */
function weightedEntityOverlap(
  a: string[],
  b: string[],
  idf: Map<string, number> | undefined,
): number {
  const setA = new Set(a.map(normalizeEntity).filter(Boolean));
  const setB = new Set(b.map(normalizeEntity).filter(Boolean));

  // Сущностей нет ни у одной стороны — признак не голосует.
  if (setA.size === 0 && setB.size === 0) return 0.5;
  if (setA.size === 0 || setB.size === 0) return 0;

  const weight = (entity: string) => idf?.get(entity) ?? 1;
  const sum = (set: Set<string>) => [...set].reduce((acc, e) => acc + weight(e), 0);

  let intersection = 0;
  for (const entity of setA) if (setB.has(entity)) intersection += weight(entity);

  const denominator = Math.min(sum(setA), sum(setB));
  return denominator === 0 ? 0 : Math.min(1, intersection / denominator);
}

/**
 * Вклад признаков в итоговую оценку.
 *
 * Наибольший вес отдан сущностям, а не «семантике», и это сделано по
 * результатам проверки на реальных формулировках. С локальным провайдером
 * эмбеддингов семантический признак по сути измеряет ту же лексику, и на
 * двух РАЗНЫХ ДТП, описанных почти одинаковыми словами, он оказывается
 * выше (0.70), чем на двух сообщениях об ОДНОМ ДТП, написанных разными
 * словами (0.46). Название улицы разводит эти случаи надёжно, поэтому
 * решающий голос отдан совпадению упомянутых объектов и мест.
 */
const WEIGHTS: Record<keyof DedupSignals, number> = {
  semantic: 0.28,
  entities: 0.30,
  lexical: 0.10,
  time: 0.14,
  geo: 0.12,
  category: 0.06,
};

/**
 * Сходство, выше которого текст считается перепечаткой.
 * Независимая редакция почти никогда не пишет настолько похожий текст.
 */
const REPRINT_SIMILARITY = 0.93;

export function compareForDedup(
  a: DedupCandidate,
  b: DedupCandidate,
  options: DedupOptions,
): DedupVerdict {
  const signals = computeSignals(a, b, options.timeWindowHours, options.entityIdf);

  const rawScore = (Object.keys(WEIGHTS) as Array<keyof DedupSignals>).reduce(
    (sum, key) => sum + signals[key] * WEIGHTS[key],
    0,
  );

  const { score, decision, explanation } = applyRules(signals, rawScore, options, a, b);

  const sharedMedia = hasSharedMedia(a, b);
  const isReprint = sharedMedia || signals.lexical >= REPRINT_SIMILARITY || signals.semantic >= 0.97;

  return {
    score: round(score),
    decision,
    signals: {
      semantic: round(signals.semantic),
      entities: round(signals.entities),
      lexical: round(signals.lexical),
      time: round(signals.time),
      geo: round(signals.geo),
      category: round(signals.category),
    },
    isReprint,
    explanation: sharedMedia
      ? `${explanation} Совпадают медиафайлы — вероятна перепечатка, а не независимое подтверждение.`
      : explanation,
  };
}

function computeSignals(
  a: DedupCandidate,
  b: DedupCandidate,
  windowHours: number,
  idf?: Map<string, number>,
): DedupSignals {
  const semantic =
    a.embedding && b.embedding ? Math.max(0, cosineSimilarity(a.embedding, b.embedding)) : 0;

  const entities = weightedEntityOverlap(a.entities, b.entities, idf);

  const lexical = jaccardSimilarity(
    stemAll(significantWords(a.post.normalizedText ?? a.post.rawText)),
    stemAll(significantWords(b.post.normalizedText ?? b.post.rawText)),
  );

  // Близость по времени затухает плавно: публикации об одном происшествии
  // появляются в течение нескольких часов, а не одновременно.
  const hoursApart =
    Math.abs(new Date(a.post.postedAt).getTime() - new Date(b.post.postedAt).getTime()) / 3_600_000;
  const time = hoursApart >= windowHours ? 0 : Math.exp(-hoursApart / (windowHours / 3));

  const geo = computeGeoSignal(a, b);

  const category =
    a.categorySlug && b.categorySlug ? (a.categorySlug === b.categorySlug ? 1 : 0) : 0.5;

  return { semantic, entities, lexical, time, geo, category };
}

function computeGeoSignal(a: DedupCandidate, b: DedupCandidate): number {
  if (
    a.latitude == null || a.longitude == null ||
    b.latitude == null || b.longitude == null
  ) {
    // Координат нет — признак не голосует ни за, ни против.
    return 0.5;
  }
  const km = haversineKm(a.latitude, a.longitude, b.latitude, b.longitude);
  // Шкала городская, а не областная: в пределах города два километра —
  // это уже другая улица и, как правило, другое происшествие. Прежняя
  // шкала в 15 км оценивала соседние районы как «почти одно место» и
  // подталкивала к ошибочному объединению.
  if (km <= 0.7) return 1;
  if (km >= 3) return 0;
  return 1 - (km - 0.7) / (3 - 0.7);
}

/**
 * Правила и пороги поверх взвешенной оценки.
 *
 * Сама по себе сумма весов слишком легко «набирается» на общих словах,
 * поэтому решение дополнительно проверяется правилами.
 */
function applyRules(
  signals: DedupSignals,
  rawScore: number,
  options: DedupOptions,
  a: DedupCandidate,
  b: DedupCandidate,
): { score: number; decision: DedupVerdict['decision']; explanation: string } {
  let score = rawScore;
  const notes: string[] = [];

  // Публикации вне временно́го окна не объединяются ни при каком сходстве:
  // одинаковая формулировка спустя двое суток — это другое происшествие.
  if (signals.time === 0) {
    return {
      score: 0,
      decision: 'separate',
      explanation: 'Публикации вне допустимого временно́го окна — объединение исключено.',
    };
  }

  // Главное правило ТЗ: одного совпадения слов недостаточно. Если лексика
  // похожа, но ни сущности, ни семантика этого не подтверждают, оценка
  // снижается — скорее всего это два однотипных, но разных происшествия.
  const strongSignals = [
    signals.semantic >= 0.7,
    signals.entities >= 0.4,
    signals.geo >= 0.8,
  ].filter(Boolean).length;

  if (strongSignals === 0 && signals.lexical >= 0.5) {
    score *= 0.55;
    notes.push(
      'Совпадает только лексика, но не сущности и не семантика — вероятно, разные однотипные происшествия.',
    );
  }

  // Явно разные места — сильный довод против объединения.
  if (signals.geo === 0) {
    score *= 0.5;
    notes.push('Географические привязки существенно расходятся.');
  }

  // Непересекающиеся сущности при наличии их у обеих публикаций.
  if (signals.entities === 0 && signals.semantic < 0.85) {
    score *= 0.7;
    notes.push('Нет общих упомянутых объектов и мест.');
  }

  // Разные категории — ослабляем, но не запрещаем: классификация могла
  // ошибиться, а ДТП вполне может быть и «происшествием», и «транспортом».
  if (signals.category === 0) {
    score *= 0.85;
    notes.push('Категории публикаций различаются.');
  }

  // --- Правила по конкретному месту --------------------------------------
  //
  // Это главный различитель. Низкое сходство текстов НЕ является доводом
  // против объединения: две редакции описывают одно происшествие разными
  // словами. И наоборот, почти одинаковый текст не означает одно событие —
  // однотипные сводки о разных ДТП пишутся по одному шаблону.
  const placesA = specificPlaces(a.entities);
  const placesB = specificPlaces(b.entities);
  const sharedPlaces = [...placesA].filter((place) => placesB.has(place));

  if (placesA.size > 0 && placesB.size > 0) {
    if (sharedPlaces.length > 0) {
      // Одно и то же конкретное место, близкое время и одна категория —
      // это подпись одного происшествия, и она сильнее любого сходства
      // формулировок. Требование близкого времени существенно: два разных
      // ДТП на одной улице за сутки не должны слиться в одно событие.
      const strong = signals.time >= 0.9 && signals.category === 1;
      score = Math.min(1, score * (strong ? 1.35 : 1.15));
      notes.push(
        `Совпадает конкретное место: ${sharedPlaces.join(', ')}.` +
          (strong ? ' Время и категория также совпадают.' : ''),
      );
    } else {
      // Обе публикации называют место, и места РАЗНЫЕ — это разные
      // происшествия, каким бы похожим ни был текст.
      score = Math.min(score, options.reviewThreshold * 0.95);
      notes.push(
        `Названы разные места (${[...placesA].join(', ')} против ${[...placesB].join(', ')}) — объединение исключено.`,
      );
    }
  }

  // Требуем не менее двух независимых подтверждающих признаков.
  const supporting = [
    signals.semantic >= 0.6,
    signals.entities >= 0.3,
    signals.lexical >= 0.35,
    signals.geo >= 0.8,
  ].filter(Boolean).length;

  // Одно место, одно время и одна категория — повод показать человеку,
  // даже если тексты лексически не пересекаются. Автоматически такие
  // публикации не объединяются, но и молча разводить их неправильно.
  const contextAgrees =
    signals.geo >= 0.9 && signals.time >= 0.7 && signals.category === 1 && signals.entities >= 0.4;

  let decision: DedupVerdict['decision'];
  if (score >= options.mergeThreshold && supporting >= 2) {
    decision = 'merge';
    notes.unshift('Достаточно независимых признаков для объединения.');
  } else if (score >= options.reviewThreshold) {
    decision = 'review';
    notes.unshift(
      supporting < 2
        ? 'Оценка высокая, но подтверждающих признаков мало — требуется проверка человеком.'
        : 'Оценка в пограничной зоне — требуется проверка человеком.',
    );
  } else if (contextAgrees) {
    decision = 'review';
    notes.unshift(
      'Тексты лексически не пересекаются, но место, время и категория совпадают — нужна проверка человеком.',
    );
  } else {
    decision = 'separate';
    notes.unshift('Сходство недостаточно — создаётся отдельное событие.');
  }

  return { score: Math.max(0, Math.min(1, score)), decision, explanation: notes.join(' ') };
}

function hasSharedMedia(a: DedupCandidate, b: DedupCandidate): boolean {
  const left = a.mediaChecksums ?? [];
  const right = new Set(b.mediaChecksums ?? []);
  return left.some((checksum) => right.has(checksum));
}

/** Расстояние между точками на сфере, км. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
