import { useState } from 'react';
import { useEventDetail, useMapMarkers } from '../api/hooks.js';
import { PageHeader } from '../components/layout/PageHeader.jsx';
import { EventMap } from '../components/map/EventMap.jsx';
import { EventInspector } from '../components/inspector/EventInspector.jsx';
import { Panel, QueryState, Segmented } from '../components/ui/primitives.jsx';
import { formatCount } from '../lib/format.js';

/** Карта событий на весь экран. */
export function MapPage() {
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('24h');
  const [selected, setSelected] = useState<string | null>(null);

  const hours = period === '24h' ? 24 : period === '7d' ? 168 : 720;
  const markers = useMapMarkers(hours);
  const detail = useEventDetail(selected);

  return (
    <>
      <PageHeader
        title="Карта событий"
        subtitle={
          markers.data
            ? `${formatCount(markers.data.length, ['событие', 'события', 'событий'])} с координатами`
            : 'География происшествий по городу'
        }
      />

      <div className="workspace">
        <Panel
          title="Новороссийск"
          actions={
            <Segmented
              value={period}
              onChange={setPeriod}
              options={[
                { value: '24h', label: '24ч' },
                { value: '7d', label: '7д' },
                { value: '30d', label: '30д' },
              ]}
            />
          }
        >
          <QueryState isLoading={markers.isLoading} error={markers.error}>
            <EventMap markers={markers.data ?? []} onSelect={setSelected} height={560} />
            <p
              style={{
                marginTop: 'var(--space-3)',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-muted)',
              }}
            >
              Карта схематическая и строится локально: обращений к внешним картографическим
              сервисам нет, поэтому содержимое ленты не покидает контур системы. Место
              определяется по упоминаниям в тексте и может быть неточным.
            </p>
          </QueryState>
        </Panel>
      </div>

      {selected && detail.data && (
        <div
          className="overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <div className="inspector-row" style={{ gridTemplateColumns: 'minmax(0, 560px)' }}>
            <EventInspector detail={detail.data} onClose={() => setSelected(null)} />
          </div>
        </div>
      )}
    </>
  );
}
