import { useMemo, useState } from 'react';
import { MAP_BOUNDS, type MapMarker } from '@nnm/shared';
import { formatTime } from '../../lib/format.js';

/**
 * Карта событий (ТЗ §14).
 *
 * Карта схематическая и рисуется локально в SVG. Внешние тайл-серверы
 * сознательно не используются: панель приватная, и запрос тайлов раскрывал
 * бы стороннему сервису, какие районы просматривает владелец. Береговая
 * линия и магистрали заданы упрощённо — их достаточно, чтобы понять,
 * в какой части города произошло событие.
 */

const VIEW_WIDTH = 340;
const VIEW_HEIGHT = 232;

/** Упрощённый контур Цемесской бухты и береговой линии. */
const BAY_PATH =
  'M132,18 C150,44 168,62 186,86 C202,108 214,132 210,158 C206,182 188,200 164,206 ' +
  'C140,212 116,204 100,186 C84,168 78,142 86,116 C94,90 112,44 132,18 Z';

const COAST_PATH =
  'M40,6 C70,30 104,54 128,84 C150,112 164,142 178,176 C186,196 196,214 210,228';

const ROADS = [
  { d: 'M12,54 C64,64 116,78 168,96 C214,112 262,132 330,150', major: true },
  { d: 'M60,10 C74,52 90,98 104,148 C112,178 118,204 124,228', major: true },
  { d: 'M6,140 C58,134 110,130 162,132 C214,134 266,142 334,158', major: false },
  { d: 'M150,6 C176,40 206,74 240,104 C268,128 300,150 336,168', major: false },
  { d: 'M20,196 C70,186 122,180 174,182 C228,184 282,194 336,210', major: false },
];

const LABELS = [
  { x: 92, y: 108, text: 'Центр' },
  { x: 52, y: 62, text: 'Приморский' },
  { x: 150, y: 176, text: 'Южный' },
  { x: 236, y: 118, text: 'Восточный' },
  { x: 170, y: 120, text: 'Порт' },
  { x: 268, y: 58, text: 'Цемдолина' },
];

const CATEGORY_COLORS: Record<string, string> = {
  dtp: '#ef4444',
  incidents: '#f97316',
  fire: '#dc2626',
  crime: '#b91c1c',
  city: '#3b82f6',
  transport: '#22d3ee',
  utilities: '#8b5cf6',
  weather: '#0ea5e9',
  government: '#6366f1',
  economy: '#f59e0b',
  society: '#10b981',
  events: '#ec4899',
  sport: '#84cc16',
  other: '#94a3b8',
};

export function EventMap({
  markers,
  onSelect,
  height = 232,
}: {
  markers: MapMarker[];
  onSelect?: (eventId: string) => void;
  height?: number;
}) {
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<MapMarker | null>(null);

  /** Перевод географических координат в координаты рисунка. */
  const projected = useMemo(
    () =>
      markers.map((marker) => {
        const x =
          ((marker.longitude - MAP_BOUNDS.minLongitude) /
            (MAP_BOUNDS.maxLongitude - MAP_BOUNDS.minLongitude)) *
          VIEW_WIDTH;
        // Ось Y инвертируется: в SVG она растёт вниз, широта — вверх.
        const y =
          VIEW_HEIGHT -
          ((marker.latitude - MAP_BOUNDS.minLatitude) /
            (MAP_BOUNDS.maxLatitude - MAP_BOUNDS.minLatitude)) *
            VIEW_HEIGHT;
        return { marker, x, y };
      }),
    [markers],
  );

  const viewBox = useMemo(() => {
    const w = VIEW_WIDTH / zoom;
    const h = VIEW_HEIGHT / zoom;
    return `${(VIEW_WIDTH - w) / 2} ${(VIEW_HEIGHT - h) / 2} ${w} ${h}`;
  }, [zoom]);

  return (
    <div className="map" style={{ height }}>
      <svg className="map__svg" viewBox={viewBox} style={{ height }} role="img" aria-label="Карта событий">
        <rect className="map__water" x="0" y="0" width={VIEW_WIDTH} height={VIEW_HEIGHT} />
        <path className="map__land" d={`M0,0 H${VIEW_WIDTH} V${VIEW_HEIGHT} H0 Z`} />
        <path className="map__water" d={BAY_PATH} />
        <path className="map__coast" d={COAST_PATH} />

        {ROADS.map((road, index) => (
          <path
            key={index}
            className={`map__road${road.major ? ' map__road--major' : ''}`}
            d={road.d}
          />
        ))}

        {LABELS.map((label) => (
          <text key={label.text} className="map__label" x={label.x} y={label.y}>
            {label.text}
          </text>
        ))}

        {projected.map(({ marker, x, y }) => {
          const color = CATEGORY_COLORS[marker.categorySlug] ?? CATEGORY_COLORS.other;
          const radius = marker.importance === 'CRITICAL' ? 5.5 : marker.importance === 'HIGH' ? 4.5 : 3.5;
          return (
            <g key={marker.eventId}>
              {/* Критические события выделяются кольцом. */}
              {(marker.importance === 'CRITICAL' || marker.importance === 'HIGH') && (
                <circle className="map__marker-ring" cx={x} cy={y} r={radius + 3.5} stroke={color} />
              )}
              <circle
                className="map__marker"
                cx={x}
                cy={y}
                r={radius}
                fill={color}
                stroke="#040a12"
                strokeWidth={1}
                onMouseEnter={() => setHovered(marker)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelect?.(marker.eventId)}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
              >
                <title>{marker.title}</title>
              </circle>
            </g>
          );
        })}
      </svg>

      <div className="map__zoom">
        <button type="button" onClick={() => setZoom((z) => Math.min(3, z + 0.4))} aria-label="Приблизить">
          +
        </button>
        <button type="button" onClick={() => setZoom((z) => Math.max(1, z - 0.4))} aria-label="Отдалить">
          −
        </button>
      </div>

      <div className="map__legend">
        {[
          ['dtp', 'Происшествия'],
          ['city', 'Общество'],
          ['transport', 'Транспорт'],
          ['other', 'Другое'],
        ].map(([slug, label]) => (
          <span key={slug} className="map__legend-item">
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: CATEGORY_COLORS[slug as string],
              }}
            />
            {label}
          </span>
        ))}
      </div>

      {hovered && (
        <div
          className="chart-tooltip"
          style={{ left: 12, top: 12, maxWidth: 260, whiteSpace: 'normal' }}
        >
          <div className="chart-tooltip__title">{formatTime(hovered.occurredAt)}</div>
          <div style={{ fontSize: 'var(--text-sm)' }}>{hovered.title}</div>
        </div>
      )}
    </div>
  );
}
