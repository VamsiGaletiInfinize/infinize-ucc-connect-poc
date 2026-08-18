import {
  notFound,
  type CallDirection,
  type CallStatus,
  type TicketCategory,
  type UccCall,
  type UccTicket,
} from '@ucc/types';
import { logger, newId, newTraceId, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';
import type { TicketService } from '@ucc/services/ticketing';
import type { IdentityService } from '@ucc/services/identity';
import type { TelephonyProvider } from '@ucc/services/telephony';

export interface StartCallResult {
  call: UccCall;
  ticket: UccTicket;
  /** False when a redelivered provider event resolved to an existing call. */
  created: boolean;
}

/**
 * UccCall lifecycle.
 *
 * EVERY contact — inbound or outbound — produces a UccCall and a UccTicket at start
 * (constitution Principle II). Call start is idempotent on `providerContactId`, so a
 * redelivered CALL_STARTED returns the existing case instead of creating a second one.
 */
export class CallService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly tickets: TicketService,
    private readonly identity: IdentityService,
    private readonly telephony: TelephonyProvider,
  ) {}

  /** Handle an inbound contact arriving from the telephony provider. */
  async startInbound(params: {
    tenantId: string;
    providerContactId: string;
    callerPhoneNumber: string;
    providerEventId?: string;
    occurredAt?: string;
  }): Promise<StartCallResult> {
    return this.start({ ...params, direction: 'INBOUND' });
  }

  /**
   * Place an outbound contact through the telephony provider.
   *
   * The provider is asked to dial; UCC then opens the case. Outbound contacts are cases
   * exactly like inbound ones.
   */
  async startOutbound(params: {
    tenantId: string;
    callerId: string;
    destinationPhoneNumber: string;
    category?: TicketCategory;
    departmentId?: string;
  }): Promise<StartCallResult> {
    const traceId = newTraceId();
    const { providerContactId } = await this.telephony.startOutboundContact({
      destinationPhoneNumber: params.destinationPhoneNumber,
      attributes: {
        uccTenantId: params.tenantId,
        uccTraceId: traceId,
        uccDirection: 'OUTBOUND',
      },
    });

    return this.start({
      tenantId: params.tenantId,
      providerContactId,
      callerPhoneNumber: params.destinationPhoneNumber,
      direction: 'OUTBOUND',
      traceId,
      category: params.category,
      departmentId: params.departmentId,
    });
  }

  private async start(params: {
    tenantId: string;
    providerContactId: string;
    callerPhoneNumber: string;
    direction: CallDirection;
    providerEventId?: string;
    occurredAt?: string;
    traceId?: string;
    category?: TicketCategory;
    departmentId?: string;
  }): Promise<StartCallResult> {
    // Idempotency: a duplicate provider delivery resolves to the existing case.
    const existing = await this.repos.call.byProviderContactId(
      params.tenantId,
      params.providerContactId,
    );
    if (existing) {
      const ticket = await this.repos.ticket.byCallId(params.tenantId, existing.id);
      logger.info('Duplicate call start ignored', {
        traceId: existing.traceId,
        tenantId: params.tenantId,
        providerContactId: params.providerContactId,
      });
      return { call: existing, ticket: ticket!, created: false };
    }

    const traceId = params.traceId ?? newTraceId();
    const caller = await this.identity.resolveCallerByPhone(
      params.tenantId,
      params.callerPhoneNumber,
    );
    const now = params.occurredAt ?? nowIso();

    const call: UccCall = {
      id: newId('call'),
      tenantId: params.tenantId,
      provider: this.telephony.name,
      providerContactId: params.providerContactId,
      direction: params.direction,
      channel: 'VOICE',
      callerId: params.callerPhoneNumber,
      callerType: caller?.callerType ?? 'UNKNOWN',
      callerRefId: caller?.id,
      status: 'AI_HANDLING',
      departmentId: params.departmentId,
      startedAt: now,
      answeredAt: now,
      traceId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await this.repos.call.put(call);

    await this.events.emit({
      tenantId: call.tenantId,
      uccCallId: call.id,
      type: 'CALL_STARTED',
      actor: 'PROVIDER',
      traceId,
      // Provider event id makes redelivery a no-op at the timeline too.
      discriminator: params.providerEventId ?? params.providerContactId,
      payload: {
        direction: call.direction,
        provider: call.provider,
        providerContactId: call.providerContactId,
        callerType: call.callerType,
        identified: Boolean(caller),
      },
      occurredAt: now,
    });

    const ticket = await this.tickets.createForCall(call, {
      category: params.category,
      priority: params.direction === 'OUTBOUND' ? 'NORMAL' : 'NORMAL',
    });

    logger.info('Contact opened', {
      traceId,
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      direction: call.direction,
      provider: call.provider,
    });

    return { call, ticket, created: true };
  }

  async get(tenantId: string, callId: string): Promise<UccCall> {
    const call = await this.repos.call.get(tenantId, callId);
    if (!call) throw notFound('Call', callId);
    return call;
  }

  list(tenantId: string) {
    return this.repos.call.list(tenantId);
  }

  async update(tenantId: string, callId: string, patch: Partial<UccCall>): Promise<UccCall> {
    const call = await this.get(tenantId, callId);
    const updated: UccCall = { ...call, ...patch, updatedAt: nowIso() };
    await this.repos.call.put(updated);
    return updated;
  }

  async setStatus(tenantId: string, callId: string, status: CallStatus): Promise<UccCall> {
    return this.update(tenantId, callId, { status });
  }

  /**
   * End a contact.
   *
   * Idempotent: a second CALL_ENDED for the same contact does not re-close the case or
   * duplicate the timeline entry.
   */
  async endCall(params: {
    tenantId: string;
    callId: string;
    reason?: 'COMPLETED' | 'ABANDONED' | 'FAILED';
    providerEventId?: string;
  }): Promise<UccCall> {
    const call = await this.get(params.tenantId, params.callId);
    if (call.endedAt) return call;

    const endedAt = nowIso();
    const duration = Math.max(
      0,
      Math.round((Date.parse(endedAt) - Date.parse(call.startedAt)) / 1000),
    );

    const updated = await this.update(params.tenantId, params.callId, {
      status: params.reason === 'ABANDONED' ? 'ABANDONED' : 'COMPLETED',
      endedAt,
      duration,
    });

    const ticket = await this.repos.ticket.byCallId(params.tenantId, params.callId);

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.callId,
      uccTicketId: ticket?.id,
      type: 'CALL_ENDED',
      actor: 'PROVIDER',
      traceId: call.traceId,
      discriminator: params.providerEventId ?? params.callId,
      payload: { duration, reason: params.reason ?? 'COMPLETED' },
      occurredAt: endedAt,
    });

    return updated;
  }
}
