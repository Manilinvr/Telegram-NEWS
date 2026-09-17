import { describe, expect, it } from 'vitest';
import { ProfanityGuard } from '../../src/modules/profanity/index.js';

/**
 * Тесты фильтра нецензурной лексики.
 *
 * Приоритет №4 в ТЗ — абсолютное отсутствие мата в готовых материалах,
 * поэтому набор намеренно включает попытки обхода фильтра. Не менее важна
 * вторая половина тестов: обычный новостной текст НЕ должен блокироваться,
 * иначе фильтр станет нерабочим на практике и его начнут игнорировать.
 */

const guard = new ProfanityGuard();

/** Слово-маркер, чтобы не тиражировать мат в тексте тестов. */
const MAT = {
  hui: ['х', 'у', 'й'].join(''),
  pizdec: ['п', 'и', 'з', 'д', 'е', 'ц'].join(''),
  blyad: ['б', 'л', 'я', 'д', 'ь'].join(''),
  ebal: ['е', 'б', 'а', 'л'].join(''),
  ohuel: ['о', 'х', 'у', 'е', 'л'].join(''),
};

describe('ProfanityGuard — обнаружение прямого мата', () => {
  it.each([
    ['корень х*й', MAT.hui],
    ['корень п*зд', MAT.pizdec],
    ['корень бл*дь', MAT.blyad],
    ['глагольная группа', MAT.ebal],
    ['производное с приставкой', MAT.ohuel],
  ])('блокирует %s', (_label, word) => {
    const report = guard.validateEditorialText(`На месте происшествия очевидец сказал: ${word}.`);
    expect(report.allowed).toBe(false);
    expect(report.matches.some((m) => m.severity === 'BLOCK')).toBe(true);
  });

  it('сообщает исходный фрагмент, а не нормализованный', () => {
    const matches = guard.detectProfanity(`Он крикнул ХУЙ вот так`);
    expect(matches.length).toBeGreaterThan(0);
    // Модератор должен видеть то, что реально написано в источнике.
    expect(matches[0]!.original).toBe('ХУЙ');
  });
});

describe('ProfanityGuard — попытки обхода фильтра', () => {
  const bypasses: Array<[string, string]> = [
    ['верхний регистр', 'ХУЙ'],
    ['смешанный регистр', 'ХуЙ'],
    ['латинские гомоглифы', 'xyй'],
    ['полностью латиницей', 'huy'],
    ['цифры вместо букв', '6лядь'],
    ['цифра ноль вместо о', 'п0шел на х0й'],
    ['повтор букв', 'хуууууй'],
    ['повтор согласных', 'ххуй'],
    ['пробелы между буквами', 'х у й'],
    ['точки между буквами', 'х.у.й'],
    ['дефисы между буквами', 'б-л-я-д-ь'],
    ['подчёркивания', 'х_у_й'],
    ['символ-заполнитель вместо гласной', 'х*й'],
    ['решётка вместо гласной', 'п#здец'],
    ['разрыв на короткие куски', 'ху й'],
    ['мягкий перенос внутри слова', 'ху­й'],
    ['нулевой пробел внутри слова', 'ху​й'],
    ['диакритика поверх букв', 'х́у́й'],
    ['латинская e в корне', 'ебaл'],
    ['растянутое слово', 'б л я д ь'],
    ['полноширинные символы', 'ｘｙй'],
    ['математические начертания', '\u{1D431}\u{1D432}й'],
    ['смешение алфавитов внутри слова', 'хyй'],
    ['процент вместо гласной', 'БЛ%ДЬ'],
    ['собака вместо гласной', 'еб@ть'],
    ['многоточия между буквами', 'х...у...й'],
    ['вертикальная черта', 'х|у|й'],
  ];

  it.each(bypasses)('ловит обход: %s', (_label, text) => {
    const report = guard.validateEditorialText(`Комментарий очевидца: ${text}`);
    expect(report.allowed, `не заблокировано: "${text}"`).toBe(false);
  });
});

describe('ProfanityGuard — отсутствие ложных срабатываний', () => {
  /**
   * Реальные формулировки из городской новостной повестки. Все они содержат
   * фрагменты, совпадающие с корнями мата, но матом не являются.
   */
  const cleanTexts = [
    'Я подстрахую коллегу на дежурстве.',
    'Подстрахуй его, пожалуйста.',
    'Синоптики обещают тихую погоду без ветра.',
    'Спасатели вышли в сухую погоду.',
    'В глухую ночь сработала пожарная сигнализация.',
    'Рабочие погребали кабель в траншею.',
    'Погребение состоится завтра.',
    'Волонтёры начали хлебать суп из полевой кухни.',
    'Жители требовали отремонтировать дорогу.',
    'Городу требуется новая техника.',
    'Потребность в кадрах выросла вдвое.',
    'Ребёнок не пострадал.',
    'Ребята помогли пожилым соседям.',
    'На дорогу высыпали щебень.',
    'Команда МЧС прибыла на место.',
    'Городская команда выиграла турнир.',
    'В магазин привезли мандарины.',
    'Атеросклеротические бляшки выявили у пациента.',
    'Бляха ремня была найдена на месте.',
    'Небольшой пожар потушили за час.',
    'Небо затянуло тучами.',
    'Спортсмены гребли к берегу.',
    'Гребень волны достигал двух метров.',
    'Колебания напряжения зафиксированы в сети.',
    'Не стоит теребить провод.',
    'Себестоимость работ выросла.',
    'Ему выдали справку по месту требования.',
    'Лебеди вернулись на озеро.',
    'Жеребёнок родился на ферме.',
    'В Херсоне прошёл дождь.',
    'На дегустацию привезли херес.',
    'Стебель растения повреждён.',
    'Дебит скважины снизился.',
    'Употребление воды из-под крана временно ограничено.',
    'Прошёл молебен в храме.',
    'Сукно на столе заменили.',
    'Собака ощенилась, щенки здоровы.',
    'Урожай зерновых собран полностью.',
    'Он уродился крепким.',
    'Лохматый пёс найден у школы.',
    'Цех уйдёт на плановый ремонт.',
    'Три уха у игрушки — брак производства.',
    'Занятия по классу фортепиано возобновятся.',
    'Массовое мероприятие перенесли.',
  ];

  it.each(cleanTexts)('не блокирует: %s', (text) => {
    const report = guard.validateEditorialText(text);
    expect(
      report.allowed,
      `ложное срабатывание: ${JSON.stringify(report.matches.map((m) => m.original))}`,
    ).toBe(true);
  });

  it('пропускает связный новостной текст целиком', () => {
    const article = [
      'В Новороссийске на улице Видова произошло ДТП с участием двух автомобилей.',
      'По предварительной информации, пострадавших нет.',
      'На месте работают сотрудники ДПС, движение затруднено.',
      'Городская администрация сообщила, что требуется дополнительная техника.',
      'Жители Восточного района сообщили об отключении воды.',
    ].join(' ');

    const report = guard.validateEditorialText(article);
    expect(report.allowed).toBe(true);
    expect(report.matches).toHaveLength(0);
  });
});

describe('ProfanityGuard — проверка всех полей материала', () => {
  it('проверяет заголовок, тело, подписи, цитаты и preview', () => {
    const report = guard.validateEditorialText({
      title: 'Обычный заголовок',
      body: 'Нейтральный текст новости.',
      captions: ['Подпись к фото'],
      quotes: [`Очевидец сказал: ${MAT.blyad}`],
      keyPhrases: ['ключевая фраза'],
      telegramPreview: 'Превью поста',
    });

    expect(report.allowed).toBe(false);
    // В отчёте должно быть видно, в каком именно поле найдена проблема.
    expect(report.matches.some((m) => m.field?.startsWith('quotes'))).toBe(true);
  });

  it('находит мат в ключевых фразах из видео', () => {
    const report = guard.validateEditorialText({
      title: 'Заголовок',
      keyPhrases: ['всё нормально', `тут ${MAT.hui}`],
    });
    expect(report.allowed).toBe(false);
    expect(report.matches.some((m) => m.field?.startsWith('keyPhrases'))).toBe(true);
  });
});

describe('ProfanityGuard — политика и невозможность отключения', () => {
  it('мат блокируется даже при отключённой блокировке по WARN', () => {
    const permissive = new ProfanityGuard({ blockOnWarn: false });
    const report = permissive.validateEditorialText(`Текст ${MAT.pizdec}`);
    expect(report.allowed).toBe(false);
  });

  it('грубая брань не блокирует при blockOnWarn=false, но фиксируется', () => {
    const permissive = new ProfanityGuard({ blockOnWarn: false });
    const report = permissive.validateEditorialText('Полная херня получилась');
    expect(report.allowed).toBe(true);
    expect(report.matches.some((m) => m.severity === 'WARN')).toBe(true);
  });

  it('по умолчанию грубая брань блокируется', () => {
    const report = guard.validateEditorialText('Полная херня получилась');
    expect(report.allowed).toBe(false);
  });

  it('финальная проверка перед публикацией всегда строгая', () => {
    const permissive = new ProfanityGuard({ blockOnWarn: false });
    // Тот же текст проходит обычную проверку, но не финальную.
    expect(permissive.validateEditorialText('Полная херня').allowed).toBe(true);
    expect(permissive.validateBeforePublish('Полная херня').allowed).toBe(false);
  });

  it('учитывает пользовательские запрещённые слова', () => {
    const custom = new ProfanityGuard({ extraBlockWords: ['запрещёнка'] });
    expect(custom.validateEditorialText('Это запрещёнка').allowed).toBe(false);
    expect(guard.validateEditorialText('Это запрещёнка').allowed).toBe(true);
  });

  it('учитывает пользовательские исключения', () => {
    const custom = new ProfanityGuard({ extraAllowWords: ['херня'] });
    expect(custom.validateEditorialText('Полная херня').allowed).toBe(true);
  });
});

describe('ProfanityGuard — очистка текста', () => {
  it('удаляет предложение целиком, а не маскирует звёздочками', () => {
    const input = `Первое предложение нейтральное. Очевидец крикнул ${MAT.blyad}. Третье предложение тоже нейтральное.`;
    const result = guard.sanitizeEditorialText(input);

    expect(result.stillHasProfanity).toBe(false);
    expect(result.removedSentences).toHaveLength(1);
    // Маскировка запрещена: смысл не должен оставаться читаемым.
    expect(result.text).not.toContain('*');
    expect(result.text).toContain('Первое предложение нейтральное.');
    expect(result.text).toContain('Третье предложение тоже нейтральное.');
  });

  it('оставляет чистый текст без изменений', () => {
    const input = 'Совершенно нейтральный текст новости.';
    const result = guard.sanitizeEditorialText(input);
    expect(result.text).toBe(input);
    expect(result.removedSentences).toHaveLength(0);
  });

  it('готовит исходный текст для AI, не разрушая структуру', () => {
    const { text, hadProfanity } = guard.prepareSourceTextForAi(
      `Водитель сказал ${MAT.blyad} и уехал с места ДТП.`,
    );
    expect(hadProfanity).toBe(true);
    expect(text).toContain('[нецензурно]');
    expect(text).toContain('и уехал с места ДТП.');
    // В подготовленном тексте мата уже нет.
    expect(guard.detectProfanity(text)).toHaveLength(0);
  });
});

describe('ProfanityGuard — англоязычная брань', () => {
  it.each(['what the fuck', 'this is shit', 'f u c k', 'fuсk'])('блокирует: %s', (text) => {
    expect(guard.validateEditorialText(text).allowed).toBe(false);
  });

  it('не блокирует нейтральные английские слова', () => {
    for (const text of ['class schedule', 'mass media', 'pass the test', 'assembly hall']) {
      expect(guard.validateEditorialText(text).allowed, text).toBe(true);
    }
  });
});

describe('ProfanityGuard — устойчивость и производительность', () => {
  it('«похую» блокируется, а «тихую»/«сухую» — нет', () => {
    expect(guard.validateEditorialText('да похую всё это').allowed).toBe(false);
    expect(guard.validateEditorialText('синоптики обещают тихую погоду').allowed).toBe(true);
    expect(guard.validateEditorialText('перетихую волну не заметили').allowed).toBe(true);
  });

  it('проверка длинного текста укладывается в разумное время', () => {
    // Фильтр вызывается на каждой публикации и на каждом сохранении
    // черновика, поэтому он не должен становиться узким местом.
    const article = 'В Новороссийске произошло дорожно-транспортное происшествие. '.repeat(400);
    const started = performance.now();
    const report = guard.validateEditorialText(article);
    const elapsed = performance.now() - started;

    expect(report.allowed).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  it('не зацикливается на строке из одних разделителей', () => {
    expect(() => guard.detectProfanity('... --- ___ *** ')).not.toThrow();
    expect(guard.detectProfanity('... --- ___ *** ')).toHaveLength(0);
  });
});

describe('ProfanityGuard — структура отчёта', () => {
  it('возвращает поля, предусмотренные ТЗ', () => {
    const report = guard.validateEditorialText(`Текст ${MAT.hui}`);
    expect(report).toMatchObject({
      allowed: false,
      matches: expect.any(Array),
      reason: expect.any(String),
      normalizedText: expect.any(String),
      rulesVersion: expect.any(String),
      checkedAt: expect.any(String),
    });
    expect(report.reason).toContain('запрещённая лексика');
  });

  it('пустой текст не вызывает ошибок', () => {
    expect(guard.detectProfanity('')).toHaveLength(0);
    expect(guard.validateEditorialText('').allowed).toBe(true);
    expect(guard.validateEditorialText({ title: null, body: undefined }).allowed).toBe(true);
  });
});
