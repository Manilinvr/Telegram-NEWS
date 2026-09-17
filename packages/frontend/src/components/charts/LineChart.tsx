import { useId, useMemo, useState } from 'react';
import type { TimeseriesPoint } from '@nnm/shared';
import { formatTime } from '../../lib/format.js';

/**
 * График динамики публикаций (ТЗ §15).
 *
 * Рисуется вручную в SVG вместо подключения библиотеки графиков: нужен
 * ровно один тип графика, полный контроль над оформлением и никакой
 * дополнительной загрузки в приватной панели.
 */

interface Props {
  points: TimeseriesPoint[];
  height?: number;
  /** Показывать вторую линию — события. */
  showEvents?: boolean;
}

export function LineChart({ points, height = 168, showEvents = true }: Props) {
  const gradientId = useId();
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const width = 600;
  const padding = { top: 12, right: 8, bottom: 22, left: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const { postLine, eventLine, area, maxValue, ticks } = useMemo(() => {
    if (points.length === 0) {
      return { postLine: '', eventLine: '', area: '', maxValue: 0, ticks: [] as number[] };
    }

    const max = Math.max(1, ...points.map((p) => Math.max(p.posts, showEvents ? p.events : 0)));
    // Округляем верх шкалы вверх до «круглого» значения, чтобы подписи
    // оси были читаемыми, а линия не упиралась в край области.
    const niceMax = niceCeil(max);

    const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
    const toX = (index: number) => padding.left + index * stepX;
    const toY = (value: number) => padding.top + plotHeight - (value / niceMax) * plotHeight;

    const build = (accessor: (p: TimeseriesPoint) => number) =>
      points.map((point, index) => `${index === 0 ? 'M' : 'L'}${toX(index)},${toY(accessor(point))}`).join(' ');

    const postPath = build((p) => p.posts);
    const areaPath =
      points.length > 1
        ? `${postPath} L${toX(points.length - 1)},${padding.top + plotHeight} L${padding.left},${padding.top + plotHeight} Z`
        : '';

    return {
      postLine: postPath,
      eventLine: showEvents ? build((p) => p.events) : '',
      area: areaPath,
      maxValue: niceMax,
      ticks: [0, niceMax / 2, niceMax],
    };
  }, [points, plotWidth, plotHeight, padding.left, padding.top, showEvents]);

  if (points.length === 0) {
    return (
      <div style={{ height, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
        Нет данных за период
      </div>
    );
  }

  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const hovered = hover ? points[hover.index] : null;

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        role="img"
        aria-label="Динамика публикаций"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => {
          const y = padding.top + plotHeight - (tick / maxValue) * plotHeight;
          return (
            <g key={tick}>
              <line className="chart__grid-line" x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
              <text className="chart__axis-label" x={padding.left - 6} y={y + 3} textAnchor="end">
                {Math.round(tick)}
              </text>
            </g>
          );
        })}

        {area && <path d={area} fill={`url(#${gradientId})`} />}
        {eventLine && <path className="chart__line chart__line--secondary" d={eventLine} />}
        <path className="chart__line" d={postLine} />

        {hovered && hover && (
          <>
            <line
              className="chart__grid-line"
              x1={padding.left + hover.index * stepX}
              y1={padding.top}
              x2={padding.left + hover.index * stepX}
              y2={padding.top + plotHeight}
              stroke="var(--border-strong)"
            />
            <circle
              className="chart__dot"
              cx={padding.left + hover.index * stepX}
              cy={padding.top + plotHeight - (hovered.posts / maxValue) * plotHeight}
              r={4}
            />
          </>
        )}

        {/* Подписи оси времени: показываем каждую N-ю, чтобы не слипались. */}
        {points.map((point, index) => {
          const every = Math.max(1, Math.ceil(points.length / 7));
          if (index % every !== 0) return null;
          return (
            <text
              key={point.bucket}
              className="chart__axis-label"
              x={padding.left + index * stepX}
              y={height - 6}
              textAnchor="middle"
            >
              {formatTime(point.bucket)}
            </text>
          );
        })}

        {/* Прозрачные области для наведения — по одной на точку. */}
        {points.map((point, index) => (
          <rect
            key={`hit-${point.bucket}`}
            className="chart__hit"
            x={padding.left + index * stepX - stepX / 2}
            y={padding.top}
            width={Math.max(stepX, 6)}
            height={plotHeight}
            onMouseEnter={() =>
              setHover({
                index,
                x: ((padding.left + index * stepX) / width) * 100,
                y: 0,
              })
            }
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {hovered && hover && (
        <div
          className="chart-tooltip"
          style={{
            left: `${hover.x}%`,
            top: 0,
            transform: `translateX(${hover.x > 70 ? '-105%' : '8px'})`,
          }}
        >
          <div className="chart-tooltip__title">{formatTime(hovered.bucket)}</div>
          <div className="chart-tooltip__row">
            <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--accent)' }} />
            Публикаций: <strong>{hovered.posts}</strong>
          </div>
          {showEvents && (
            <div className="chart-tooltip__row">
              <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--info)' }} />
              Событий: <strong>{hovered.events}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Округлить максимум шкалы вверх до «круглого» значения. */
function niceCeil(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}
