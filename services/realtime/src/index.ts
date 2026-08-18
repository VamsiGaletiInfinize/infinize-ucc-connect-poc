import type { UccEvent } from '@ucc/types';
import { logger } from '@ucc/shared';
import type { EventService } from '@ucc/services/events';

export interface RealtimeMessage {
  type: 'EVENT' | 'HEARTBEAT' | 'HELLO';
  event?: UccEvent;
  at: string;
}

export type RealtimeSubscriber = (message: RealtimeMessage) => void;

/**
 * Realtime fan-out over Server-Sent Events.
 *
 * ADR-0005: SSE rather than AppSync subscriptions. The dashboard is a one-way,
 * server-to-browser stream of contact centre state; SSE delivers that over plain HTTP with
 * no GraphQL schema, no client codegen and no extra service to operate. AppSync earns its
 * place when clients need to mutate through the same channel or when subscriptions must
 * fan out across regions — neither applies at POC scale, and the production path is
 * documented rather than pre-built.
 */
export class RealtimeHub {
  private readonly subscribers = new Set<RealtimeSubscriber>();
  private unsubscribeEvents?: () => void;

  constructor(private readonly events: EventService) {}

  /** Begin forwarding committed events to connected clients. */
  start(): void {
    if (this.unsubscribeEvents) return;
    this.unsubscribeEvents = this.events.subscribe((event) => {
      this.broadcast({ type: 'EVENT', event, at: new Date().toISOString() });
    });
  }

  stop(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
  }

  subscribe(subscriber: RealtimeSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber({ type: 'HELLO', at: new Date().toISOString() });
    logger.debug('Realtime subscriber connected', { subscribers: this.subscribers.size });
    return () => {
      this.subscribers.delete(subscriber);
      logger.debug('Realtime subscriber disconnected', { subscribers: this.subscribers.size });
    };
  }

  broadcast(message: RealtimeMessage): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(message);
      } catch (error) {
        logger.warn('Realtime delivery failed', { error: String(error) });
      }
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
