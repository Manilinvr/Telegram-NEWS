import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveEventType, LiveMessage } from '@nnm/shared';

/**
 * Подписка на живые обновления (ТЗ §15, §16).
 *
 * EventSource переподключается сам при разрыве связи, поэтому отдельная
 * логика восстановления не нужна. Приходящие события не перезагружают весь
 * экран, а точечно помечают устаревшими только затронутые данные.
 */
export function useLiveUpdates(enabled: boolean): {
  connected: boolean;
  lastEvent: LiveMessage | null;
} {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveMessage | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
      return;
    }

    const source = new EventSource('/api/live', { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => {
      // Браузер повторит подключение самостоятельно; показываем разрыв.
      setConnected(false);
    };

    /** Какие данные устарели при каждом типе события. */
    const invalidationMap: Partial<Record<LiveEventType, string[][]>> = {
      'post.created': [['feed'], ['dashboard']],
      'event.created': [['feed'], ['dashboard'], ['map']],
      'event.updated': [['feed'], ['dashboard']],
      'draft.created': [['moderation'], ['dashboard']],
      'moderation.updated': [['moderation'], ['dashboard'], ['feed']],
      'publication.created': [['moderation'], ['dashboard'], ['feed']],
      'source.health': [['sources'], ['diagnostics']],
      'job.failed': [['diagnostics']],
      'stats.updated': [['dashboard']],
    };

    const handler = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as LiveMessage;
        setLastEvent(message);

        for (const key of invalidationMap[message.type] ?? []) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
      } catch {
        // Некорректный кадр не должен ломать подписку.
      }
    };

    const types: LiveEventType[] = [
      'post.created',
      'event.created',
      'event.updated',
      'draft.created',
      'moderation.updated',
      'publication.created',
      'source.health',
      'job.failed',
      'stats.updated',
    ];
    for (const type of types) source.addEventListener(type, handler as EventListener);

    return () => {
      for (const type of types) source.removeEventListener(type, handler as EventListener);
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [enabled, queryClient]);

  return { connected, lastEvent };
}

/** Текущее время с обновлением раз в секунду — для часов в шапке. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return now;
}
