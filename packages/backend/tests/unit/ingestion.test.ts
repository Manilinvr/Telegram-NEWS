import { describe, expect, it } from 'vitest';
import { parsePreviewPage } from '../../src/modules/ingestion/telegram.js';
import { htmlToText, decodeEntities } from '../../src/modules/ingestion/html.js';
import {
  extractEntities,
  geocodeLocation,
  jaccardSimilarity,
  normalizeForAnalysis,
  significantWords,
  stem,
} from '../../src/lib/text.js';

/** Фрагмент разметки страницы предпросмотра канала. */
const PREVIEW_HTML = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="novoros_news/1041" data-view="1">
    <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.telegram-cdn.org/file/photo1.jpg')" href="#"></a>
    <div class="tgme_widget_message_text js-message_text" dir="auto">В Новороссийске на улице Видова произошло ДТП.<br/>Движение затруднено &mdash; работают сотрудники ДПС.</div>
    <span class="tgme_widget_message_views">2.1K</span>
    <time datetime="2026-04-14T14:32:00+00:00">14:32</time>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="novoros_news/1042" data-view="1">
    <a class="tgme_widget_message_forwarded_from_name" href="#">Пресс-служба города</a>
    <video src="https://cdn.telegram-cdn.org/file/video1.mp4"></video>
    <time class="message_video_duration">0:28</time>
    <div class="tgme_widget_message_text js-message_text" dir="auto">Комментарий очевидца с места события.</div>
    <time datetime="2026-04-14T15:10:00+00:00">15:10</time>
  </div>
</div>
`;

describe('Разбор страницы предпросмотра Telegram', () => {
  const posts = parsePreviewPage(PREVIEW_HTML, 'novoros_news');

  it('находит все публикации', () => {
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.externalId)).toEqual(['1041', '1042']);
  });

  it('строит корректную ссылку на оригинал', () => {
    expect(posts[0]!.url).toBe('https://t.me/novoros_news/1041');
  });

  it('извлекает текст с переносами и раскодирует сущности', () => {
    expect(posts[0]!.text).toContain('В Новороссийске на улице Видова произошло ДТП.');
    expect(posts[0]!.text).toContain('\n');
    // &mdash; должен превратиться в тире, а не остаться разметкой.
    expect(posts[0]!.text).toContain('—');
    expect(posts[0]!.text).not.toContain('&mdash;');
  });

  it('разбирает дату публикации', () => {
    expect(posts[0]!.postedAt.toISOString()).toBe('2026-04-14T14:32:00.000Z');
  });

  it('извлекает фотографии', () => {
    expect(posts[0]!.media).toHaveLength(1);
    expect(posts[0]!.media[0]).toMatchObject({
      type: 'PHOTO',
      url: 'https://cdn.telegram-cdn.org/file/photo1.jpg',
    });
  });

  it('извлекает видео с длительностью', () => {
    const video = posts[1]!.media.find((m) => m.type === 'VIDEO');
    expect(video?.url).toBe('https://cdn.telegram-cdn.org/file/video1.mp4');
    expect(video?.durationSeconds).toBe(28);
  });

  it('определяет пересылку и её источник', () => {
    expect(posts[1]!.isForward).toBe(true);
    expect(posts[1]!.forwardFrom).toBe('Пресс-служба города');
    expect(posts[0]!.isForward).toBe(false);
  });

  it('не падает на пустой или неожиданной разметке', () => {
    expect(parsePreviewPage('', 'channel')).toEqual([]);
    expect(parsePreviewPage('<html><body>нет сообщений</body></html>', 'channel')).toEqual([]);
  });
});

describe('Утилиты HTML', () => {
  it('раскодирует числовые и именованные сущности', () => {
    expect(decodeEntities('&laquo;Тест&raquo; &amp; &#1090;&#1077;&#1082;&#1089;&#1090;')).toBe(
      '«Тест» & текст',
    );
  });

  it('превращает разметку в текст с переносами', () => {
    expect(htmlToText('Первая<br/>Вторая<a href="#">ссылка</a>')).toBe('Первая\nВтораяссылка');
  });
});

describe('Нормализация текста для анализа', () => {
  it('убирает ссылки, хештеги и рекламные хвосты', () => {
    const input =
      'В городе прошёл фестиваль. #новороссийск https://t.me/channel Подписывайтесь на наш канал!';
    const result = normalizeForAnalysis(input);
    expect(result).toContain('В городе прошёл фестиваль');
    expect(result).not.toContain('https://');
    expect(result).not.toContain('#новороссийск');
    expect(result.toLowerCase()).not.toContain('подписывайтесь');
  });

  it('оставляет содержательный текст нетронутым', () => {
    expect(normalizeForAnalysis('На трассе М-4 затруднено движение.')).toBe(
      'На трассе М-4 затруднено движение.',
    );
  });
});

describe('Извлечение сущностей и геопривязка', () => {
  it('находит улицу в тексте', () => {
    const entities = extractEntities('ДТП произошло на улице Видова около полудня.');
    expect(entities).toContain('Видова');
  });

  it('находит улицу и при сокращённой записи', () => {
    expect(extractEntities('Перекрыта ул. Анапское шоссе.')).toContain('Анапское');
  });

  it('находит известные ориентиры города', () => {
    const entities = extractEntities('Мероприятие пройдёт на набережной.');
    expect(entities).toContain('Набережная Адмирала Серебрякова');
  });

  it('привязывает место к координатам по локальному справочнику', () => {
    const point = geocodeLocation('Новороссийск, ул. Видова');
    expect(point).not.toBeNull();
    expect(point!.latitude).toBeCloseTo(44.73, 1);
    expect(point!.longitude).toBeCloseTo(37.75, 1);
  });

  it('возвращает центр города при упоминании без уточнения', () => {
    expect(geocodeLocation('Новороссийск')?.matched).toBe('Новороссийск');
  });

  it('возвращает null для неизвестного места', () => {
    expect(geocodeLocation('Владивосток, улица Светланская')).toBeNull();
    expect(geocodeLocation(null)).toBeNull();
  });
});

describe('Сравнение текстов', () => {
  it('отбрасывает стоп-слова', () => {
    const words = significantWords('В городе на улице произошло крупное ДТП');
    expect(words).toContain('произошло');
    expect(words).toContain('крупное');
    expect(words).not.toContain('в');
    expect(words).not.toContain('на');
  });

  it('приводит словоформы к общей основе', () => {
    expect(stem('пожара')).toBe(stem('пожаре'));
    expect(stem('машина')).toBe(stem('машины'));
    expect(stem('столкнулись')).toBe(stem('столкнулся'));
  });

  it('оценивает пересечение лексики', () => {
    const a = significantWords('На улице Видова произошло ДТП с двумя автомобилями');
    const b = significantWords('ДТП на улице Видова: столкнулись два автомобиля');
    const c = significantWords('В городе открыли новый детский сад');

    expect(jaccardSimilarity(a, b)).toBeGreaterThan(jaccardSimilarity(a, c));
    expect(jaccardSimilarity(a, [])).toBe(0);
  });
});
