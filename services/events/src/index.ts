import type { UccEvent, UccEventType } from '@ucc/types';
import { eventIdempotencyKey, logger, newId, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';

export interface EmitEventInput {
  tenantId: string;
  uccCallId: string;
  uccTicketId?: string;
  type: UccEventType;
  actor: UccEvent['actor'];
  actorId?: string;
  traceId: string;
  /**
   * Distinguishes legitimately repeated events of the same type on one call.
   * Supply the provider's event id where one exists so redelivery collapses to a no-op.
   */
  discriminator?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

export type EventListener = (event: UccEvent) => void;

/**
 * Normalized event pipeline.
 *
 * Every state change in the contact centre passes through here so the timeline is the
 * single source of truth for what happened. Emission is idempotent: a duplicate provider
 * delivery produces the same idempotency key and is discarded at the storage layer
 * (constitution Principle VI).
 */
export class EventService {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly repos: Repositories) {}

  /** Subscribe to committed events — used by the realtime SSE hub. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Append an event to the timeline.
   *
   * Returns the event when it was newly recorded, or `null` when it was a duplicate.
   * Callers that must not double-apply a side effect should branch on this result.
   */
  async emit(input: EmitEventInput): Promise<UccEvent | null> {
    const occurredAt = input.occurredAt ?? nowIso();
    // Default discriminator: the occurrence timestamp. Callers handling provider traffic
    // pass the provider event id instead, which is what makes redelivery safe.
    const discriminator = input.discriminator ?? occurredAt;

    const event: UccEvent = {
      id: newId('evt'),
      tenantId: input.tenantId,
      uccCallId: input.uccCallId,
      uccTicketId: input.uccTicketId,
      type: input.type,
      idempotencyKey: eventIdempotencyKey(input.uccCallId, input.type, discriminator),
      payload: input.payload ?? {},
      actor: input.actor,
      actorId: input.actorId,
      traceId: input.traceId,
      occurredAt,
      createdAt: nowIso(),
    };

    const appended = await this.repos.event.append(event);
    if (!appended) {
      logger.debug('Duplicate event suppressed', {
        traceId: input.traceId,
        tenantId: input.tenantId,
        uccCallId: input.uccCallId,
        type: input.type,
      });
      return null;
    }

    logger.info('Call event recorded', {
      traceId: event.traceId,
      tenantId: event.tenantId,
      uccCallId: event.uccCallId,
      uccTicketId: event.uccTicketId,
      type: event.type,
      actor: event.actor,
    });

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('Event listener failed', { traceId: event.traceId, error: String(error) });
      }
    }

    return event;
  }

  timelineForCall(tenantId: string, uccCallId: string) {
    return this.repos.event.byCallId(tenantId, uccCallId);
  }

  timelineForTicket(tenantId: string, uccTicketId: string) {
    return this.repos.event.byTicketId(tenantId, uccTicketId);
  }
}
