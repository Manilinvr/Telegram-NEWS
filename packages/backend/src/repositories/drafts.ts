import type { AiDraft, Importance, ProfanityReport, SourceClaim } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapDraft } from './mappers.js';

export interface NewDraftInput {
  eventId: string;
  title: string;
  body: string;
  telegramText: string;
  categorySlug: string | null;
  importance: Importance;
  locationText: string | null;
  witnessQuotes: string[];
  uncertainties: string[];
  sourceClaims: SourceClaim[];
  confidence: number;
  createdBy: 'AI' | 'HUMAN' | 'RULES';
  createdByUser?: string | null;
  model?: string | null;
  rawResponse?: unknown;
  profanityReport: ProfanityReport;
}

export class DraftsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Создать новую версию черновика.
   *
   * Предыдущие версии не удаляются и не перезаписываются — сохраняется
   * полная история правок (ТЗ §10). Текущей помечается только новая версия.
   */
  async create(input: NewDraftInput): Promise<AiDraft> {
    return this.db.transaction(async (tx) => {
      await tx.query('UPDATE ai_drafts SET is_current = false WHERE event_id = $1 AND is_current', [
        input.eventId,
      ]);

      const versionRow = await tx.one(
        'SELECT COALESCE(max(version), 0) + 1 AS next FROM ai_drafts WHERE event_id = $1',
        [input.eventId],
      );

      const row = await tx.one(
        `INSERT INTO ai_drafts
           (event_id, version, title, body, telegram_text, category_slug, importance,
            location_text, witness_quotes, uncertainties, source_claims, confidence,
            profanity_checked, profanity_passed, profanity_report,
            created_by, created_by_user, model, raw_response, is_current)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$17,$18,true)
         RETURNING *`,
        [
          input.eventId,
          Number(versionRow.next),
          input.title,
          input.body,
          input.telegramText,
          input.categorySlug,
          input.importance,
          input.locationText,
          JSON.stringify(input.witnessQuotes),
          JSON.stringify(input.uncertainties),
          JSON.stringify(input.sourceClaims),
          input.confidence,
          input.profanityReport.allowed,
          JSON.stringify(input.profanityReport),
          input.createdBy,
          input.createdByUser ?? null,
          input.model ?? null,
          input.rawResponse ? JSON.stringify(input.rawResponse) : null,
        ],
      );

      return mapDraft(row);
    });
  }

  async findCurrent(eventId: string): Promise<AiDraft | null> {
    const row = await this.db.maybeOne(
      'SELECT * FROM ai_drafts WHERE event_id = $1 AND is_current',
      [eventId],
    );
    return row ? mapDraft(row) : null;
  }

  async findById(id: string): Promise<AiDraft | null> {
    const row = await this.db.maybeOne('SELECT * FROM ai_drafts WHERE id = $1', [id]);
    return row ? mapDraft(row) : null;
  }

  async history(eventId: string): Promise<AiDraft[]> {
    const rows = await this.db.many(
      'SELECT * FROM ai_drafts WHERE event_id = $1 ORDER BY version DESC',
      [eventId],
    );
    return rows.map(mapDraft);
  }
}
