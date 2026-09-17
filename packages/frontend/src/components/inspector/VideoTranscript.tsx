import { useRef, useState } from 'react';
import type { MediaItemView, Transcript } from '@nnm/shared';
import { formatDuration } from '../../lib/format.js';
import { Badge, EmptyState } from '../ui/primitives.jsx';
import { IconVideo } from '../ui/Icons.jsx';

/**
 * Видео и транскрипция (ТЗ §9).
 *
 * Полная расшифровка доступна здесь, в админке, и не обязана попадать в
 * пост. Неразборчивые фрагменты показаны явной пометкой: система не
 * додумывает неуслышанные слова, и модератор должен это видеть.
 */
export function VideoTranscript({
  media,
  transcripts,
}: {
  media: MediaItemView[];
  transcripts: Transcript[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videos = media.filter((item) => item.type === 'VIDEO');
  const [activeIndex, setActiveIndex] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const activeVideo = videos[activeIndex];
  const transcript = transcripts.find((item) => item.mediaId === activeVideo?.id) ?? transcripts[0];

  if (videos.length === 0 && transcripts.length === 0) {
    return (
      <EmptyState
        icon={<IconVideo size={28} />}
        title="Видео нет"
        hint="К этому событию не прикреплено видеоматериалов."
      />
    );
  }

  /** Перемотать плеер к таймкоду сегмента. */
  const seekTo = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      void videoRef.current.play();
    }
  };

  return (
    <div>
      {activeVideo?.url && (
        <>
          <video
            ref={videoRef}
            className="video-panel__player"
            src={activeVideo.url}
            controls
            preload="metadata"
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          />
          {videos.length > 1 && (
            <div className="video-panel__strip">
              {videos.map((item, index) => (
                <img
                  key={item.id}
                  src={item.thumbnailUrl ?? item.url ?? ''}
                  alt=""
                  onClick={() => setActiveIndex(index)}
                  style={index === activeIndex ? { borderColor: 'var(--accent)' } : undefined}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="detail-section" style={{ marginTop: 'var(--space-4)' }}>
        <div className="detail-section__title">
          Транскрипция
          {transcript && (
            <>
              <Badge tone={transcript.status === 'COMPLETED' ? 'success' : 'muted'}>
                {transcriptStatusLabel(transcript.status)}
              </Badge>
              {transcript.unclearSegmentCount > 0 && (
                <Badge tone="warning">неразборчиво: {transcript.unclearSegmentCount}</Badge>
              )}
            </>
          )}
        </div>

        {!transcript || transcript.segments.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)' }}>
            {transcript?.error ??
              'Транскрипция недоступна. Событие и черновик это не блокирует.'}
          </p>
        ) : (
          <div className="transcript">
            {transcript.segments.map((segment, index) => {
              const isActive = currentTime >= segment.start && currentTime < segment.end;
              return (
                <button
                  key={index}
                  type="button"
                  className={`transcript__segment${isActive ? ' transcript__segment--active' : ''}${
                    segment.unclear ? ' transcript__segment--unclear' : ''
                  }`}
                  onClick={() => seekTo(segment.start)}
                >
                  <span className="transcript__time">{formatDuration(segment.start)}</span>
                  <span className="transcript__text">
                    {segment.speaker && <span className="transcript__speaker">{segment.speaker}</span>}
                    {segment.text}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {transcript?.fullText && (
        <details className="detail-section">
          <summary
            style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}
          >
            Полная транскрипция одним текстом
          </summary>
          <p
            style={{
              marginTop: 'var(--space-2)',
              fontSize: 'var(--text-base)',
              lineHeight: 1.6,
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {transcript.fullText}
          </p>
        </details>
      )}
    </div>
  );
}

function transcriptStatusLabel(status: Transcript['status']): string {
  const labels: Record<Transcript['status'], string> = {
    PENDING: 'В очереди',
    PROCESSING: 'Обработка',
    COMPLETED: 'Готова',
    UNAVAILABLE: 'Недоступна',
    FAILED: 'Ошибка',
    SKIPPED: 'Пропущена',
  };
  return labels[status];
}
