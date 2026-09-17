import type { SourcePost } from '@nnm/shared';
import { jaccardSimilarity, significantWords, stemAll } from '../../lib/text.js';
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
  const signals = computeSignals(a, b, options.timeWindowHours);

  const rawScore = (Object.keys(WEIGHTS) as Array<keyof DedupSignals>).reduce(
    (sum, key) => sum + signals[key] * WEIGHTS[key],
    0,
  );

  const { score, decision, explanation } = applyRules(signals, rawScore, options);

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

function computeSignals(a: DedupCandidate, b: DedupCandidate, windowHours: number): DedupSignals {
  const semantic =
    a.embedding && b.embedding ? Math.max(0, cosineSimilarity(a.embedding, b.embedding)) : 0;

  const entities = jaccardSimilarity(
    a.entities.map((e) => e.toLowerCase()),
    b.entities.map((e) => e.toLowerCase()),
  );

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

  // Согласие трёх независимых признаков — сильный довод: одни и те же
  // объекты, то же место и близкое время. Текст при этом может быть
  // написан совсем другими словами, и полагаться на одну лексику нельзя.
  if (signals.entities >= 0.6 && signals.geo >= 0.9 && signals.time >= 0.8) {
    score = Math.min(1, score * 1.08);
    notes.push('Совпадают объекты, место и время — признаки согласованы.');
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
