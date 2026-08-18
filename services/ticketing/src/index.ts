import {
  assertTransition,
  isTerminal,
  notFound,
  UccError,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
  type UccCall,
  type UccTicket,
  type VerificationStatus,
} from '@ucc/types';
import { logger, newId, nextTicketNumber, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';

/**
 * UccTicket lifecycle.
 *
 * A ticket is created for EVERY contact at call start (constitution Principle II), not
 * only when the AI escalates. All status changes go through `transition`, which validates
 * against the explicit state machine — there is no code path that writes `status` directly.
 */
export class TicketService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
  ) {}

  /**
   * Open the business case for a contact.
   *
   * Idempotent per call: if a ticket already exists for this UccCall it is returned
   * unchanged, so a redelivered CALL_STARTED never creates a second case.
   */
  async createForCall(
    call: UccCall,
    opts: {
      category?: TicketCategory;
      priority?: TicketPriority;
      verificationStatus?: VerificationStatus;
    } = {},
  ): Promise<UccTicket> {
    const existing = await this.repos.ticket.byCallId(call.tenantId, call.id);
    if (existing) return existing;

    const now = nowIso();
    const ticket: UccTicket = {
      id: newId('tkt'),
      ticketNumber: nextTicketNumber(),
      tenantId: call.tenantId,
      uccCallId: call.id,
      callerId: call.callerRefId ?? call.callerId,
      callerType: call.callerType,
      category: opts.category ?? 'GENERAL_ENQUIRY',
      priority: opts.priority ?? 'NORMAL',
      departmentId: call.departmentId,
      verificationStatus: opts.verificationStatus ?? 'NOT_REQUIRED',
      status: 'AI_HANDLING',
      notes: [],
      relatedApplicationIds: [],
      traceId: call.traceId,
      createdAt: now,
      updatedAt: now,
    };

    await this.repos.ticket.put(ticket);

    await this.events.emit({
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      type: 'CASE_CREATED',
      actor: 'SYSTEM',
      traceId: call.traceId,
      discriminator: call.id,
      payload: { ticketNumber: ticket.ticketNumber, direction: call.direction },
    });

    logger.info('Case opened', {
      traceId: call.traceId,
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
    });

    return ticket;
  }

  async get(tenantId: string, ticketId: string): Promise<UccTicket> {
    const ticket = await this.repos.ticket.get(tenantId, ticketId);
    if (!ticket) throw notFound('Ticket', ticketId);
    return ticket;
  }

  /**
   * Apply a guarded status transition.
   *
   * Invalid transitions throw `InvalidTicketTransitionError`. This is the ONLY way a
   * ticket status changes anywhere in the system.
   */
  async transition(
    tenantId: string,
    ticketId: string,
    to: TicketStatus,
    context: {
      actor: 'AI' | 'AGENT' | 'SYSTEM' | 'CALLER';
      actorId?: string;
      reason?: string;
      agentId?: string;
      departmentId?: string;
      resolution?: string;
      summary?: string;
    },
  ): Promise<UccTicket> {
    const ticket = await this.get(tenantId, ticketId);

    if (isTerminal(ticket.status) && ticket.status === to) return ticket;
    assertTransition(ticket.status, to);

    const now = nowIso();
    const updated: UccTicket = {
      ...ticket,
      status: to,
      updatedAt: now,
      assignedAgentId: context.agentId ?? ticket.assignedAgentId,
      departmentId: context.departmentId ?? ticket.departmentId,
      resolution: context.resolution ?? ticket.resolution,
      summary: context.summary ?? ticket.summary,
      resolvedAt: to === 'RESOLVED' ? now : ticket.resolvedAt,
      closedAt: to === 'CLOSED' ? now : ticket.closedAt,
    };

    await this.repos.ticket.put(updated);

    logger.info('Ticket transitioned', {
      traceId: ticket.traceId,
      tenantId,
      uccTicketId: ticketId,
      from: ticket.status,
      to,
      actor: context.actor,
      reason: context.reason,
    });

    if (to === 'RESOLVED' || to === 'CLOSED') {
      await this.events.emit({
        tenantId,
        uccCallId: ticket.uccCallId,
        uccTicketId: ticket.id,
        type: to === 'RESOLVED' ? 'TICKET_RESOLVED' : 'TICKET_CLOSED',
        actor: context.actor === 'CALLER' ? 'SYSTEM' : context.actor,
        actorId: context.actorId,
        traceId: ticket.traceId,
        discriminator: `${ticket.id}:${to}`,
        payload: { resolution: updated.resolution, from: ticket.status },
      });
    }

    return updated;
  }

  /** Business fields a patch is permitted to touch. `status` is deliberately absent. */
  private static readonly PATCHABLE_FIELDS = [
    'intent',
    'category',
    'priority',
    'departmentId',
    'verificationStatus',
    'summary',
    'relatedApplicationIds',
  ] as const;

  /**
   * Patch business fields.
   *
   * SECURITY (FR-003): fields are copied by explicit allowlist rather than spread. A
   * `status` supplied at runtime — from an over-permissive route, a JSON body, or a
   * future careless caller — is silently discarded. The type signature blocks it at
   * compile time; this loop blocks it at run time. Status changes only ever happen
   * through `transition`, which validates against the state machine.
   */
  async update(
    tenantId: string,
    ticketId: string,
    patch: Partial<
      Pick<
        UccTicket,
        | 'intent'
        | 'category'
        | 'priority'
        | 'departmentId'
        | 'verificationStatus'
        | 'summary'
        | 'relatedApplicationIds'
      >
    >,
  ): Promise<UccTicket> {
    const ticket = await this.get(tenantId, ticketId);
    const updated: UccTicket = { ...ticket, updatedAt: nowIso() };
    const target = updated as unknown as Record<string, unknown>;
    const source = patch as unknown as Record<string, unknown>;

    for (const field of TicketService.PATCHABLE_FIELDS) {
      if (source[field] !== undefined) {
        target[field] = source[field];
      }
    }

    await this.repos.ticket.put(updated);
    return updated;
  }

  async addNote(
    tenantId: string,
    ticketId: string,
    authorId: string,
    authorName: string,
    body: string,
  ): Promise<UccTicket> {
    if (!body.trim()) {
      throw new UccError('VALIDATION_FAILED', 'Note body cannot be empty', 400);
    }
    const ticket = await this.get(tenantId, ticketId);
    const updated: UccTicket = {
      ...ticket,
      notes: [
        ...ticket.notes,
        { id: newId('note'), authorId, authorName, body: body.trim(), createdAt: nowIso() },
      ],
      updatedAt: nowIso(),
    };
    await this.repos.ticket.put(updated);
    return updated;
  }

  /** Record that an application was discussed, for traceability on the case. */
  async linkApplication(tenantId: string, ticketId: string, applicationId: string): Promise<void> {
    const ticket = await this.get(tenantId, ticketId);
    if (ticket.relatedApplicationIds.includes(applicationId)) return;
    await this.repos.ticket.put({
      ...ticket,
      relatedApplicationIds: [...ticket.relatedApplicationIds, applicationId],
      updatedAt: nowIso(),
    });
  }

  async setVerificationStatus(
    tenantId: string,
    ticketId: string,
    verificationStatus: VerificationStatus,
  ): Promise<void> {
    const ticket = await this.get(tenantId, ticketId);
    await this.repos.ticket.put({ ...ticket, verificationStatus, updatedAt: nowIso() });
  }

  list(tenantId: string) {
    return this.repos.ticket.list(tenantId);
  }
}
