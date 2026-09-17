import { useState } from 'react';
import type { CategoryDistributionItem } from '@nnm/shared';
import { formatPercent } from '../../lib/format.js';

/**
 * Распределение событий по категориям (ТЗ §15).
 *
 * Кольцо строится дугами SVG: это позволяет выделять сегмент при наведении
 * и держать цвета в точности такими же, какие заданы для категорий в БД.
 */
export function DonutChart({
  items,
  size = 128,
  thickness = 16,
  onSelect,
}: {
  items: CategoryDistributionItem[];
  size?: number;
  thickness?: number;
  onSelect?: (slug: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);

  const total = items.reduce((sum, item) => sum + item.count, 0);
  const radius = (size - thickness) / 2;
  const center = size / 2;

  if (total === 0) {
    return (
      <div style={{ padding: 'var(--space-4)', color: 'var(--text-muted)', textAlign: 'center' }}>
        Событий за период нет
      </div>
    );
  }

  let cursor = -Math.PI / 2;

  return (
    <div className="donut">
      <div className="donut__chart" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label="Категории новостей">
          {items.map((item) => {
            const angle = (item.count / total) * Math.PI * 2;
            const path = arcPath(center, center, radius, cursor, cursor + angle, thickness);
            cursor += angle;

            return (
              <path
                key={item.slug}
                d={path}
                fill={item.color}
                className={`donut__segment${active && active !== item.slug ? ' donut__segment--dimmed' : ''}`}
                onMouseEnter={() => setActive(item.slug)}
                onMouseLeave={() => setActive(null)}
                onClick={() => onSelect?.(item.slug)}
              >
                <title>{`${item.title}: ${item.count} (${formatPercent(item.share)})`}</title>
              </path>
            );
          })}
        </svg>
        <div className="donut__center">
          <div className="donut__total">{total}</div>
          <div className="donut__total-label">всего</div>
        </div>
      </div>

      <div className="donut__legend">
        {items.slice(0, 7).map((item) => (
          <button
            key={item.slug}
            type="button"
            className="donut__legend-row"
            onMouseEnter={() => setActive(item.slug)}
            onMouseLeave={() => setActive(null)}
            onClick={() => onSelect?.(item.slug)}
          >
            <span className="donut__legend-dot" style={{ background: item.color }} />
            <span className="donut__legend-label">{item.title}</span>
            <span className="donut__legend-value">{formatPercent(item.share)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Дуга кольца между двумя углами. */
function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  thickness: number,
): string {
  const inner = radius - thickness / 2;
  const outer = radius + thickness / 2;

  // Полный круг нельзя описать одной дугой: конец совпал бы с началом.
  const sweep = endAngle - startAngle;
  const safeEnd = sweep >= Math.PI * 2 ? startAngle + Math.PI * 1.9999 : endAngle;
  const largeArc = safeEnd - startAngle > Math.PI ? 1 : 0;

  const p = (angle: number, r: number) => [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  const [x1, y1] = p(startAngle, outer);
  const [x2, y2] = p(safeEnd, outer);
  const [x3, y3] = p(safeEnd, inner);
  const [x4, y4] = p(startAngle, inner);

  return [
    `M${x1},${y1}`,
    `A${outer},${outer} 0 ${largeArc} 1 ${x2},${y2}`,
    `L${x3},${y3}`,
    `A${inner},${inner} 0 ${largeArc} 0 ${x4},${y4}`,
    'Z',
  ].join(' ');
}
