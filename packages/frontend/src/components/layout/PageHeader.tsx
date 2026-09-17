import type { ReactNode } from 'react';
import type { DashboardSummary } from '@nnm/shared';
import { TopBar } from './TopBar.jsx';
import { useShell } from '../../lib/live-context.js';

/** Шапка экрана: берёт состояние потока и управление меню из оболочки. */
export function PageHeader({
  title,
  subtitle,
  summary,
  actions,
}: {
  title: string;
  subtitle: string;
  summary?: DashboardSummary;
  actions?: ReactNode;
}) {
  const { connected, openMenu } = useShell();

  return (
    <TopBar
      title={title}
      subtitle={subtitle}
      {...(summary ? { summary } : {})}
      live={connected}
      onMenuClick={openMenu}
      {...(actions ? { actions } : {})}
    />
  );
}
