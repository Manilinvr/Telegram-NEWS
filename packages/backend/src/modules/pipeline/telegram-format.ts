import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from '@nnm/shared';

/**
 * Сборка текста Telegram-поста (ТЗ §11).
 *
 * Структура фиксирована, чтобы лента канала выглядела единообразно:
 * заголовок, короткий текст с ключевыми фактами, при необходимости место,
 * время и реплики очевидцев, и в конце — перечень источников.
 *
 * Указание источников не опционально: система не считает переработанный
 * чужой материал своим и всегда показывает, откуда сведения.
 */

export interface TelegramPostInput {
  title: string;
  body: string;
  location?: string | null;
  eventTime?: string | null;
  witnessQuotes?: string[];
  sources: Array<{ title: string; url?: string | null }>;
  /** Пост с медиа ограничен длиной подписи, а не длиной сообщения. */
  hasMedia?: boolean;
}

export function buildTelegramPost(input: TelegramPostInput): string {
  const limit = input.hasMedia ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;
  const blocks: string[] = [];

  const title = input.title.trim();
  // Тело не должно повторять заголовок. И модель, и эвристика склонны
  // начинать текст той же фразой, что стоит в заголовке, и в готовом
  // посте предложение появлялось дважды.
  const body = stripLeadingTitle(input.body.trim(), title);

  blocks.push(title);
  if (body) blocks.push(body);

  const meta: string[] = [];
  if (input.location) meta.push(`📍 ${input.location.trim()}`);
  if (input.eventTime) {
    const formatted = formatMoscowTime(input.eventTime);
    if (formatted) meta.push(`🕒 ${formatted}`);
  }
  if (meta.length > 0) blocks.push(meta.join('\n'));

  const quotes = (input.witnessQuotes ?? []).filter((quote) => quote.trim().length > 0);
  if (quotes.length > 0) {
    blocks.push(`🎥 Что говорят очевидцы: ${quotes.map((q) => `«${q.trim()}»`).join(' ')}`);
  }

  // Источники собираются без повторов и в стабильном порядке.
  const sources = dedupeSources(input.sources);
  if (sources.length > 0) {
    blocks.push(`Источник:\n${sources.map((s) => s.title).join(', ')}`);
  }

  const text = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  return text.length <= limit ? text : trimToLimit(text, limit, sources);
}

/**
 * Укоротить пост, не потеряв обязательные части.
 *
 * Обрезается основной текст; заголовок, место, время и блок источников
 * сохраняются — без них пост теряет смысл или нарушает атрибуцию.
 */
function trimToLimit(
  text: string,
  limit: number,
  sources: Array<{ title: string }>,
): string {
  const blocks = text.split('\n\n');
  const sourceBlock = sources.length > 0 ? blocks.pop() ?? '' : '';
  const reserved = sourceBlock.length + 2;

  let result = blocks.join('\n\n');
  if (result.length > limit - reserved) {
    result = `${result.slice(0, Math.max(0, limit - reserved - 1)).trimEnd()}…`;
  }
  return sourceBlock ? `${result}\n\n${sourceBlock}` : result;
}

function dedupeSources(
  sources: Array<{ title: string; url?: string | null }>,
): Array<{ title: string; url?: string | null }> {
  const seen = new Set<string>();
  const result: Array<{ title: string; url?: string | null }> = [];
  for (const source of sources) {
    const key = source.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

/**
 * Убрать из начала текста повтор заголовка.
 *
 * Сравнение ведётся по буквам и цифрам: заголовок и первое предложение
 * могут отличаться знаками препинания и регистром, оставаясь одной и той
 * же фразой.
 */
function stripLeadingTitle(body: string, title: string): string {
  const key = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const titleKey = key(title);
  if (titleKey.length < 10) return body;

  const sentences = body.split(/(?<=[.!?…])\s+/);
  const first = sentences[0];
  if (first && key(first) === titleKey) {
    return sentences.slice(1).join(' ').trim();
  }
  // Заголовок мог быть обрезан по длине — тогда он является префиксом.
  if (key(body).startsWith(titleKey) && first && key(first).startsWith(titleKey)) {
    return sentences.slice(1).join(' ').trim();
  }
  return body;
}

/** Время события в часовом поясе города. */
export function formatMoscowTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });
}

/**
 * Экранирование для Telegram MarkdownV2.
 *
 * Черновики отправляются как обычный текст (parse_mode не задаётся), но
 * функция нужна, если владелец включит форматирование: незаэкранированный
 * спецсимвол приводит к отказу Telegram в отправке всего сообщения.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
