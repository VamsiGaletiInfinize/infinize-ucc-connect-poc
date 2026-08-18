import {
  UccError,
  notFound,
  type Agent,
  type AgentStatus,
  type UccTicket,
} from '@ucc/types';
import { logger, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';
import type { TicketService } from '@ucc/services/ticketing';
import type { CallService } from '@ucc/services/calls';

/**
 * Agent workspace operations.
 *
 * The frontend never sets ticket status directly (FR-003). It calls intent-revealing
 * operations — accept, note, resolve — and this service maps each onto a guarded
 * transition, verifying that the acting agent is the one actually assigned.
 */
export class AgentService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly tickets: TicketService,
    private readonly calls: CallService,
  ) {}

  list(tenantId: string) {
    return this.repos.agent.list(tenantId);
  }

  async get(tenantId: string, agentId: string): Promise<Agent> {
    const agent = await this.repos.agent.get(tenantId, agentId);
    if (!agent) throw notFound('Agent', agentId);
    return agent;
  }

  async setStatus(tenantId: string, agentId: string, status: AgentStatus): Promise<Agent> {
    const agent = await this.get(tenantId, agentId);
    const updated: Agent = { ...agent, status, updatedAt: nowIso() };
    await this.repos.agent.put(updated);
    logger.info('Agent status changed', { tenantId, agentId, from: agent.status, to: status });
    return updated;
  }

  /** The agent accepts the assigned contact and begins handling it. */
  async acceptTicket(params: {
    tenantId: string;
    ticketId: string;
    agentId: string;
  }): Promise<UccTicket> {
    const ticket = await this.tickets.get(params.tenantId, params.ticketId);
    const agent = await this.get(params.tenantId, params.agentId);

    // Only the assigned agent may accept. This is enforced here, server-side, rather than
    // by hiding the button in the UI.
    if (ticket.assignedAgentId && ticket.assignedAgentId !== params.agentId) {
      throw new UccError(
        'NOT_AUTHORIZED',
        'This case is assigned to a different agent.',
        403,
      );
    }

    const updated = await this.tickets.transition(
      params.tenantId,
      params.ticketId,
      'AGENT_HANDLING',
      { actor: 'AGENT', actorId: params.agentId, reason: 'Agent accepted', agentId: params.agentId },
    );

    await this.repos.agent.put({
      ...agent,
      status: 'ON_CALL',
      currentCallId: ticket.uccCallId,
      updatedAt: nowIso(),
    });

    await this.calls.update(params.tenantId, ticket.uccCallId, {
      status: 'AGENT_CONNECTED',
      agentId: params.agentId,
    });

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: ticket.uccCallId,
      uccTicketId: ticket.id,
      type: 'AGENT_CONNECTED',
      actor: 'AGENT',
      actorId: params.agentId,
      traceId: ticket.traceId,
      discriminator: `${ticket.id}:connected:${params.agentId}`,
      payload: { agentId: params.agentId, agentName: `${agent.firstName} ${agent.lastName}` },
    });

    return updated;
  }

  async addNote(params: {
    tenantId: string;
    ticketId: string;
    agentId: string;
    body: string;
  }): Promise<UccTicket> {
    const agent = await this.get(params.tenantId, params.agentId);
    return this.tickets.addNote(
      params.tenantId,
      params.ticketId,
      agent.id,
      `${agent.firstName} ${agent.lastName}`,
      params.body,
    );
  }

  /** Resolve the case, release the agent, and disconnect the contact. */
  async resolveTicket(params: {
    tenantId: string;
    ticketId: string;
    agentId: string;
    resolution: string;
  }): Promise<UccTicket> {
    if (!params.resolution?.trim()) {
      throw new UccError('VALIDATION_FAILED', 'A resolution summary is required', 400);
    }

    const ticket = await this.tickets.get(params.tenantId, params.ticketId);
    const agent = await this.get(params.tenantId, params.agentId);

    if (ticket.assignedAgentId && ticket.assignedAgentId !== params.agentId) {
      throw new UccError('NOT_AUTHORIZED', 'This case is assigned to a different agent.', 403);
    }

    const updated = await this.tickets.transition(params.tenantId, params.ticketId, 'RESOLVED', {
      actor: 'AGENT',
      actorId: params.agentId,
      reason: 'Agent resolved',
      resolution: params.resolution.trim(),
      agentId: params.agentId,
    });

    await this.repos.agent.put({
      ...agent,
      status: 'AFTER_CALL_WORK',
      currentCallId: undefined,
      updatedAt: nowIso(),
    });

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: ticket.uccCallId,
      uccTicketId: ticket.id,
      type: 'AGENT_DISCONNECTED',
      actor: 'AGENT',
      actorId: params.agentId,
      traceId: ticket.traceId,
      discriminator: `${ticket.id}:disconnected:${params.agentId}`,
      payload: { agentId: params.agentId },
    });

    return updated;
  }

  /** Close a resolved case. */
  async closeTicket(params: {
    tenantId: string;
    ticketId: string;
    agentId?: string;
  }): Promise<UccTicket> {
    return this.tickets.transition(params.tenantId, params.ticketId, 'CLOSED', {
      actor: params.agentId ? 'AGENT' : 'SYSTEM',
      actorId: params.agentId,
      reason: 'Case closed',
    });
  }

  /** Everything an agent needs on screen when a case lands. */
  async workspaceContext(tenantId: string, ticketId: string) {
    const ticket = await this.tickets.get(tenantId, ticketId);
    const [call, timeline, transcript, department, caller] = await Promise.all([
      this.repos.call.get(tenantId, ticket.uccCallId),
      this.repos.event.byTicketId(tenantId, ticket.id),
      this.repos.transcript.byCallId(tenantId, ticket.uccCallId),
      ticket.departmentId ? this.repos.department.get(tenantId, ticket.departmentId) : null,
      this.repos.caller.get(tenantId, ticket.callerId),
    ]);

    const applications = caller?.studentId
      ? await this.repos.application.byStudent(tenantId, caller.studentId)
      : [];

    return {
      ticket,
      call,
      department,
      caller,
      timeline,
      transcript,
      // Agent-facing view: the agent is a verified staff member, so record detail is
      // shown for context. Disclosure to the CALLER still requires caller verification.
      applications: applications.map((a) => ({
        applicationId: a.applicationId,
        program: a.program,
        term: a.term,
        status: a.status,
        outstandingFee: a.outstandingFee,
      })),
    };
  }
}
