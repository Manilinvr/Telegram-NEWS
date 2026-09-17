import { createContext, useContext } from 'react';

/**
 * Общий контекст оболочки.
 *
 * Здесь живут состояние потока живых обновлений и управление выдвижной
 * навигацией. Подписка на SSE создаётся один раз в оболочке: несколько
 * параллельных подключений к одному серверу были бы лишней нагрузкой и
 * приводили бы к рассинхронизации обновлений между экранами.
 */
export interface ShellContextValue {
  connected: boolean;
  openMenu: () => void;
}

export const LiveContext = createContext<ShellContextValue>({
  connected: false,
  openMenu: () => undefined,
});

export function useShell(): ShellContextValue {
  return useContext(LiveContext);
}
