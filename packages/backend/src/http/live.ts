import type { FastifyReply } from 'fastify';
import type { LiveEventType, LiveMessage } from '@nnm/shared';
import { childLogger } from '../lib/logger.js';

const log = childLogger({ module: 'live' });

/**
 * Живые обновления через Server-Sent Events (ТЗ §15, §16).
 *
 * Выбран SSE, а не WebSocket: поток здесь односторонний — сервер сообщает
 * о новых публикациях и изменениях статусов. SSE проще, переживает разрывы
 * связи за счёт встроенного переподключения браузера и не требует
 * отдельного протокола на прокси.
 */
export class LiveBus {
  private readonly clients = new Map<string, { reply: FastifyReply; userId: string }>();
  private heartbeat: NodeJS.Timeout | null = null;

  /** Подключить клиента. Возвращает функцию отключения. */
  subscribe(id: string, reply: FastifyReply, userId: string): () => void {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Отключаем буферизацию на nginx: иначе события копятся и приходят пачкой.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': поток событий открыт\n\n');

    this.clients.set(id, { reply, userId });
    this.ensureHeartbeat();
    log.debug({ clientId: id, total: this.clients.size }, 'Клиент подключился к потоку событий');

    return () => this.unsubscribe(id);
  }

  unsubscribe(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    this.clients.delete(id);
    try {
      client.reply.raw.end();
    } catch {
      // Соединение уже закрыто — это нормальный путь при разрыве связи.
    }
    if (this.clients.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Разослать событие всем подключённым клиентам. */
  publish<T>(type: LiveEventType, payload: T): void {
    if (this.clients.size === 0) return;

    const message: LiveMessage<T> = { type, payload, at: new Date().toISOString() };
    const frame = `event: ${type}\ndata: ${JSON.stringify(message)}\n\n`;

    for (const [id, client] of this.clients) {
      try {
        client.reply.raw.write(frame);
      } catch (error) {
        // Мёртвое соединение не должно мешать доставке остальным.
        log.debug({ clientId: id, err: error }, 'Не удалось отправить событие, отключаю клиента');
        this.unsubscribe(id);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Периодический комментарий в поток.
   * Без него прокси и балансировщики закрывают простаивающее соединение.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [id, client] of this.clients) {
        try {
          client.reply.raw.write(': keep-alive\n\n');
        } catch {
          this.unsubscribe(id);
        }
      }
    }, 25_000);
    this.heartbeat.unref?.();
  }

  close(): void {
    for (const id of [...this.clients.keys()]) this.unsubscribe(id);
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

export const liveBus = new LiveBus();
