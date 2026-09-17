/** Географический центр Новороссийска — используется как fallback для карты. */
export const NOVOROSSIYSK_CENTER = { latitude: 44.7235, longitude: 37.7686 } as const;

/**
 * Границы отображаемой области карты. Карта рисуется схематично, локально,
 * без обращения к внешним тайл-серверам — система остаётся приватной.
 */
export const MAP_BOUNDS = {
  minLatitude: 44.6,
  maxLatitude: 44.82,
  minLongitude: 37.6,
  maxLongitude: 37.95,
} as const;

/** Известные ориентиры города — помогают AI и геокодеру привязать место. */
export const KNOWN_LOCATIONS: Array<{
  name: string;
  aliases: string[];
  latitude: number;
  longitude: number;
}> = [
  { name: 'Центр', aliases: ['центр города', 'центральный район'], latitude: 44.7235, longitude: 37.7686 },
  { name: 'Набережная Адмирала Серебрякова', aliases: ['набережная', 'серебрякова'], latitude: 44.7169, longitude: 37.7826 },
  { name: 'Площадь Героев', aliases: ['площадь героев'], latitude: 44.7196, longitude: 37.7761 },
  { name: 'Улица Видова', aliases: ['видова', 'ул. видова'], latitude: 44.7315, longitude: 37.7519 },
  { name: 'Улица Анапское шоссе', aliases: ['анапское шоссе', 'анапка'], latitude: 44.7457, longitude: 37.7318 },
  { name: 'Южный район', aliases: ['южный'], latitude: 44.6949, longitude: 37.7866 },
  { name: 'Восточный район', aliases: ['восточный'], latitude: 44.7101, longitude: 37.8102 },
  { name: 'Мысхако', aliases: ['мысхако'], latitude: 44.6683, longitude: 37.7716 },
  { name: 'Цемдолина', aliases: ['цемдолина'], latitude: 44.7638, longitude: 37.8181 },
  { name: 'Малая Земля', aliases: ['малая земля'], latitude: 44.6966, longitude: 37.7771 },
  { name: 'Порт Новороссийск', aliases: ['порт', 'нмтп', 'морской порт'], latitude: 44.7069, longitude: 37.7935 },
  { name: 'Трасса М-4 «Дон»', aliases: ['м-4', 'м4', 'трасса дон'], latitude: 44.7861, longitude: 37.7846 },
  { name: 'Трасса Новороссийск — Керчь', aliases: ['новороссийск — керчь', 'керченское шоссе', 'а-290'], latitude: 44.6803, longitude: 37.7199 },
  { name: 'Аэропорт Анапа', aliases: ['аэропорт', 'витязево'], latitude: 45.0021, longitude: 37.3473 },
  { name: 'Станица Раевская', aliases: ['раевская'], latitude: 44.8318, longitude: 37.6491 },
  { name: 'Верхнебаканский', aliases: ['верхнебаканский', 'баканка'], latitude: 44.8318, longitude: 37.7255 },
  { name: 'Кабардинка', aliases: ['кабардинка'], latitude: 44.6512, longitude: 37.9382 },
  { name: 'Абрау-Дюрсо', aliases: ['абрау', 'дюрсо', 'абрау-дюрсо'], latitude: 44.6981, longitude: 37.6021 },
];

/** Максимальная длина текста Telegram-сообщения с медиа (caption). */
export const TELEGRAM_CAPTION_LIMIT = 1024;
/** Максимальная длина обычного текстового сообщения Telegram. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Максимум элементов в одной медиа-группе Telegram. */
export const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

/** Имя cookie сессии. */
export const SESSION_COOKIE_NAME = 'nnm_session';
/** Имя cookie с CSRF-токеном (читается фронтендом, поэтому не httpOnly). */
export const CSRF_COOKIE_NAME = 'nnm_csrf';
/** Заголовок, в котором фронтенд возвращает CSRF-токен. */
export const CSRF_HEADER_NAME = 'x-csrf-token';
