import { PIPELINE_STAGE, type ModerationQueueItem, type User } from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import { AUDIT_ACTIONS, AuditRepository } from '../../repositories/audit.js';
import { DraftsRepository } from '../../repositories/drafts.js';
import { EventsRepository } from '../../repositories/events.js';
import { ModerationRepository } from '../../repositories/moderation.js';
import { OpsRepository } from '../../repositories/ops.js';
import { ProfanityGuard } from '../profanity/index.js';

/**
 * Ручная модерация (ТЗ §13).
 *
 * Одобрение — это не просто смена статуса: текст проверяется ЗАНОВО
 * непосредственно в момент одобрения. Между генерацией черновика и
 * решением модератора текст мог быть отредактирован, а прошлая проверка
 * относится к прошлой версии.
 */
export class ModerationService {
  private readonly moderation: ModerationRepository;
  private readonly drafts: DraftsRepository;
  private readonly events: EventsRepository;
  private readonly audit: AuditRepository;
  private readonly ops: OpsRepository;
  private readonly profanity: ProfanityGuard;

  constructor(private readonly db: Database, profanity?: ProfanityGuard) {
    this.moderation = new ModerationRepository(db);
    this.drafts = new DraftsRepository(db);
    this.events = new EventsRepository(db);
    this.audit = new AuditRepository(db);
    this.ops = new OpsRepository(db);
    this.profanity = profanity ?? new ProfanityGuard();
  }

  async approve(input: {
    eventId: string;
    user: User;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<
    | { ok: true; item: ModerationQueueItem }
    | { ok: false; code: 'NOT_FOUND' | 'NO_DRAFT' | 'PROFANITY_BLOCKED'; message: string }
  > {
    const draft = await this.drafts.findCurrent(input.eventId);
    if (!draft) {
      return { ok: false, code: 'NO_DRAFT', message: 'У события нет текущего черновика.' };
    }

    // Повторная проверка перед одобрением (ТЗ §13.9).
    const report = this.profanity.validateEditorialText({
      title: draft.title,
      body: draft.body,
      telegramPreview: draft.telegramText,
      quotes: draft.witnessQuotes,
    });

    if (!report.allowed) {
      await this.moderation.setStatus(input.eventId, 'BLOCKED', {
        reviewedBy: input.user.id,
        blockedReason: report.reason,
      });
      await this.ops.recordHistory({
        entityType: 'event',
        entityId: input.eventId,
        stage: PIPELINE_STAGE.PROFANITY_VALIDATION,
        status: 'BLOCKED',
        message: `Одобрение отклонено: ${report.reason}`,
      });
      return { ok: false, code: 'PROFANITY_BLOCKED', message: report.reason };
    }

    const item = await this.moderation.setStatus(input.eventId, 'APPROVED', {
      reviewedBy: input.user.id,
    });
    if (!item) return { ok: false, code: 'NOT_FOUND', message: 'Запись модерации не найдена.' };

    await this.events.setStatus(input.eventId, 'APPROVED');
    await this.audit.log({
      userId: input.user.id,
      action: AUDIT_ACTIONS.MODERATION_APPROVED,
      entityType: 'event',
      entityId: input.eventId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      details: { draftId: draft.id, version: draft.version },
    });
    await this.ops.recordHistory({
      entityType: 'event',
      entityId: input.eventId,
      stage: PIPELINE_STAGE.MODERATION,
      status: 'APPROVED',
      message: `Одобрено пользователем ${input.user.email}`,
    });

    return { ok: true, item };
  }

  async reject(input: {
    eventId: string;
    user: User;
    reason: string;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<{ ok: true; item: ModerationQueueItem } | { ok: false; message: string }> {
    const item = await this.moderation.setStatus(input.eventId, 'REJECTED', {
      reviewedBy: input.user.id,
      rejectionReason: input.reason,
    });
    if (!item) return { ok: false, message: 'Запись модерации не найдена.' };

    await this.events.setStatus(input.eventId, 'REJECTED');
    await this.audit.log({
      userId: input.user.id,
      action: AUDIT_ACTIONS.MODERATION_REJECTED,
      entityType: 'event',
      entityId: input.eventId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      details: { reason: input.reason },
    });
    await this.ops.recordHistory({
      entityType: 'event',
      entityId: input.eventId,
      stage: PIPELINE_STAGE.MODERATION,
      status: 'REJECTED',
      message: input.reason,
    });

    return { ok: true, item };
  }

  /** Взять материал в работу — чтобы двое не правили один текст. */
  async claim(eventId: string, user: User): Promise<ModerationQueueItem | null> {
    return this.moderation.setStatus(eventId, 'IN_REVIEW', { reviewedBy: user.id });
  }

  async list(status?: ModerationQueueItem['status'][]): Promise<ModerationQueueItem[]> {
    return this.moderation.list(status ? { status } : {});
  }

  async counts() {
    return this.moderation.counts();
  }
}
