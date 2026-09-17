import pino from 'pino';

/**
 * Structured logging (ТЗ §23).
 *
 * В production — строгий JSON без «красивого» вывода, чтобы логи можно было
 * собирать и искать. Секреты и токены вырезаются редактором полей: даже при
 * случайном логировании объекта конфигурации ключ не попадёт в лог.
 */

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.LOG_PRETTY === 'true' && process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? (process.env.LOG_LEVEL ?? 'silent') : level,
  redact: {
    paths: [
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'apiKey',
      '*.apiKey',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'ANTHROPIC_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_PUBLISH_BOT_TOKEN',
      'VK_ACCESS_TOKEN',
      'SESSION_SECRET',
      'CSRF_SECRET',
      'S3_SECRET_ACCESS_KEY',
      'VOYAGE_API_KEY',
      'TRANSCRIPTION_API_KEY',
    ],
    censor: '[REDACTED]',
  },
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

/** Дочерний логгер с постоянным контекстом (например, именем воркера). */
export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
