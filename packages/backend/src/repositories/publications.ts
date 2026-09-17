import type { ProfanityReport, Publication } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapPublication } from './mappers.js';

export class PublicationsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Зафиксировать результат публикации.
   *
   * Сохраняются и успешные отправки, и неудачные: причина сбоя должна
   * быть видна модератору (ТЗ §24), а материал — не потерян.
   */
  async record(input: {
    eventId: string;
    draftId: string;
    channel: string;
    telegramMessageId: string | null;
    publishedText: string;
    mediaIds: string[];
    publishedBy: string;
    dryRun: boolean;
    finalCheckReport: ProfanityReport;
    error?: string | null;
  }): Promise<Publication> {
    const row = await this.db.one(
      `INSERT INTO publications
         (event_id, draft_id, channel, telegram_message_id, published_text,
          media_ids, published_by, dry_run, final_check_report, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        input.eventId,
        input.draftId,
        input.channel,
        input.telegramMessageId,
        input.publishedText,
        input.mediaIds,
        input.publishedBy,
        input.dryRun,
        JSON.stringify(input.finalCheckReport),
        input.error ?? null,
      ],
    );
    return mapPublication(row);
  }

  async listForEvent(eventId: string): Promise<Publication[]> {
    const rows = await this.db.many(
      'SELECT * FROM publications WHERE event_id = $1 ORDER BY published_at DESC',
      [eventId],
    );
    return rows.map(mapPublication);
  }

  async list(limit = 50, offset = 0): Promise<Publication[]> {
    const rows = await this.db.many(
      'SELECT * FROM publications ORDER BY published_at DESC LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    return rows.map(mapPublication);
  }

  async counts(): Promise<{ last24h: number; total: number }> {
    const row = await this.db.one(
      `SELECT
         count(*) FILTER (WHERE published_at > now() - interval '24 hours' AND error IS NULL)::int AS last24h,
         count(*) FILTER (WHERE error IS NULL)::int AS total
       FROM publications`,
    );
    return { last24h: Number(row.last24h), total: Number(row.total) };
  }
}
