import {
  notFound,
  type Agent,
  type Callback,
  type Department,
  type DepartmentCode,
  type TicketCategory,
  type UccTicket,
} from '@ucc/types';
import { logger, newId, nowIso } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';
import type { TicketService } from '@ucc/services/ticketing';
import type { CallService } from '@ucc/services/calls';
import type { TelephonyProvider } from '@ucc/services/telephony';

/**
 * Business-level routing intelligence.
 *
 * UCC decides WHICH department a case belongs to — that is a business rule about
 * university operations. Amazon Connect then decides WHICH AGENT takes the contact, using
 * its own queues, routing profiles and agent availability. UCC does not reimplement the
 * routing engine (constitution Principle I).
 */

/** Business classification -> department. UCC owns this mapping, not the contact centre. */
const CATEGORY_TO_DEPARTMENT: Record<TicketCategory, DepartmentCode> = {
  ADMISSIONS_SUPPORT: 'ADMISSIONS',
  APPLICATION_STATUS: 'ADMISSIONS',
  DOCUMENT_SUBMISSION: 'ADMISSIONS',
  DEADLINE_REMINDER: 'ADMISSIONS',
  FEES_AND_PAYMENTS: 'FINANCIAL_AID',
  SCHOLARSHIP: 'FINANCIAL_AID',
  FINANCIAL_AID: 'FINANCIAL_AID',
  TECHNICAL_SUPPORT: 'TECHNICAL_SUPPORT',
  HOSTEL_AND_CAMPUS: 'GENERAL',
  GENERAL_ENQUIRY: 'GENERAL',
};

export interface EscalationResult {
  ticket: UccTicket;
  department: Department;
  /** Agent Connect selected, or null when every agent for the queue is unavailable. */
  agent: Agent | null;
  queuePosition: number;
  /** True when no agent was available and the caller should be offered a callback. */
  callbackRecommended: boolean;
}

export class RoutingService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly tickets: TicketService,
    private readonly calls: CallService,
    private readonly telephony: TelephonyProvider,
  ) {}

  /** Resolve the owning department for a business category. */
  async resolveDepartment(tenantId: string, category: TicketCategory): Promise<Department> {
    const code = CATEGORY_TO_DEPARTMENT[category] ?? 'GENERAL';
    const department = await this.repos.department.byCode(tenantId, code);
    if (!department) throw notFound('Department', code);
    return department;
  }

  /**
   * Escalate a case from AI to a human.
   *
   * Sequence: ESCALATED -> department resolution -> Connect queue transfer ->
   * QUEUED_FOR_AGENT -> (if an agent is available) AGENT_ASSIGNED.
   */
  async escalate(params: {
    tenantId: string;
    uccCallId: string;
    uccTicketId: string;
    category: TicketCategory;
    reason: string;
    traceId: string;
    summary?: string;
  }): Promise<EscalationResult> {
    const department = await this.resolveDepartment(params.tenantId, params.category);

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'ESCALATION_REQUESTED',
      actor: 'AI',
      traceId: params.traceId,
      discriminator: `${params.uccTicketId}:escalate`,
      payload: { reason: params.reason, category: params.category },
    });

    let ticket = await this.tickets.transition(params.tenantId, params.uccTicketId, 'ESCALATED', {
      actor: 'AI',
      reason: params.reason,
      departmentId: department.id,
      summary: params.summary,
    });

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'ROUTING_STARTED',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: `${params.uccTicketId}:routing`,
      payload: { departmentId: department.id, department: department.name },
    });

    // Hand the contact to Amazon Connect. Connect owns queueing from this point.
    const call = await this.calls.get(params.tenantId, params.uccCallId);
    await this.telephony.transferToQueue({
      providerContactId: call.providerContactId,
      queueId: department.queueId,
    });
    await this.calls.update(params.tenantId, params.uccCallId, {
      status: 'QUEUED',
      departmentId: department.id,
    });

    const queuePosition = await this.queueDepth(params.tenantId, department.id);

    ticket = await this.tickets.transition(
      params.tenantId,
      params.uccTicketId,
      'QUEUED_FOR_AGENT',
      { actor: 'SYSTEM', reason: 'Entered department queue', departmentId: department.id },
    );

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'QUEUE_ENTERED',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: `${params.uccTicketId}:queue`,
      payload: { queueId: department.queueId, queueName: department.queueName, queuePosition },
    });

    const agent = await this.findAvailableAgent(params.tenantId, department.id);

    if (!agent) {
      logger.info('No agent available for department', {
        traceId: params.traceId,
        tenantId: params.tenantId,
        uccTicketId: params.uccTicketId,
        departmentId: department.id,
      });
      return { ticket, department, agent: null, queuePosition, callbackRecommended: true };
    }

    ticket = await this.assignAgent({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      agentId: agent.id,
      traceId: params.traceId,
    });

    return { ticket, department, agent, queuePosition, callbackRecommended: false };
  }

  /** Agents serving a department who can take another contact right now. */
  async findAvailableAgent(tenantId: string, departmentId: string): Promise<Agent | null> {
    const agents = await this.repos.agent.list(tenantId);
    return (
      agents.find(
        (a) =>
          a.departmentIds.includes(departmentId) &&
          a.status === 'AVAILABLE' &&
          !a.currentCallId,
      ) ?? null
    );
  }

  /** Bind an agent to the case. The agent must still accept before handling begins. */
  async assignAgent(params: {
    tenantId: string;
    uccCallId: string;
    uccTicketId: string;
    agentId: string;
    traceId: string;
  }): Promise<UccTicket> {
    const agent = await this.repos.agent.get(params.tenantId, params.agentId);
    if (!agent) throw notFound('Agent', params.agentId);

    const ticket = await this.tickets.transition(
      params.tenantId,
      params.uccTicketId,
      'AGENT_ASSIGNED',
      { actor: 'SYSTEM', reason: 'Agent selected from queue', agentId: agent.id },
    );

    await this.repos.agent.put({
      ...agent,
      status: 'ON_CALL',
      currentCallId: params.uccCallId,
      updatedAt: nowIso(),
    });

    await this.calls.update(params.tenantId, params.uccCallId, { agentId: agent.id });

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'AGENT_ASSIGNED',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: `${params.uccTicketId}:assign:${agent.id}`,
      payload: { agentId: agent.id, agentName: `${agent.firstName} ${agent.lastName}` },
    });

    return ticket;
  }

  /** Cases waiting in a department queue. */
  async queueDepth(tenantId: string, departmentId: string): Promise<number> {
    const tickets = await this.repos.ticket.list(tenantId);
    return tickets.filter(
      (t) => t.departmentId === departmentId && t.status === 'QUEUED_FOR_AGENT',
    ).length;
  }

  async queueSnapshot(tenantId: string) {
    const [departments, tickets, agents] = await Promise.all([
      this.repos.department.list(tenantId),
      this.repos.ticket.list(tenantId),
      this.repos.agent.list(tenantId),
    ]);
    return departments.map((d) => ({
      departmentId: d.id,
      code: d.code,
      name: d.name,
      queueId: d.queueId,
      queueName: d.queueName,
      slaSeconds: d.slaSeconds,
      waiting: tickets.filter((t) => t.departmentId === d.id && t.status === 'QUEUED_FOR_AGENT')
        .length,
      inProgress: tickets.filter(
        (t) =>
          t.departmentId === d.id &&
          (t.status === 'AGENT_ASSIGNED' || t.status === 'AGENT_HANDLING'),
      ).length,
      agentsAvailable: agents.filter(
        (a) => a.departmentIds.includes(d.id) && a.status === 'AVAILABLE',
      ).length,
      agentsOnCall: agents.filter(
        (a) => a.departmentIds.includes(d.id) && a.status === 'ON_CALL',
      ).length,
    }));
  }

  // --- callback -----------------------------------------------------------

  /** Queue a callback when no agent is available or the caller prefers not to wait. */
  async requestCallback(params: {
    tenantId: string;
    uccCallId: string;
    uccTicketId: string;
    callerId: string;
    phone: string;
    departmentId: string;
    traceId: string;
    delayMinutes?: number;
  }): Promise<Callback> {
    const call = await this.calls.get(params.tenantId, params.uccCallId);
    const department = await this.repos.department.get(params.tenantId, params.departmentId);
    if (!department) throw notFound('Department', params.departmentId);

    const scheduledFor = new Date(
      Date.now() + (params.delayMinutes ?? 15) * 60_000,
    ).toISOString();

    await this.telephony.createCallback({
      providerContactId: call.providerContactId,
      queueId: department.queueId,
      destinationPhoneNumber: params.phone,
      scheduledFor,
    });

    const callback: Callback = {
      id: newId('cbk'),
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      callerId: params.callerId,
      phone: params.phone,
      departmentId: params.departmentId,
      status: 'QUEUED',
      requestedAt: nowIso(),
      scheduledFor,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.callback.put(callback);

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'CALLBACK_REQUESTED',
      actor: 'CALLER',
      traceId: params.traceId,
      discriminator: callback.id,
      payload: {
        callbackId: callback.id,
        scheduledFor,
        department: department.name,
      },
    });

    logger.info('Callback queued', {
      traceId: params.traceId,
      tenantId: params.tenantId,
      uccTicketId: params.uccTicketId,
      callbackId: callback.id,
    });

    return callback;
  }

  /** Complete a callback: dial out, bind the agent, record the outcome on the timeline. */
  async completeCallback(params: {
    tenantId: string;
    callbackId: string;
    agentId: string;
  }): Promise<Callback> {
    const callback = await this.repos.callback.get(params.tenantId, params.callbackId);
    if (!callback) throw notFound('Callback', params.callbackId);
    if (callback.status === 'COMPLETED') return callback;

    const call = await this.calls.get(params.tenantId, callback.uccCallId);

    const updated: Callback = {
      ...callback,
      status: 'COMPLETED',
      agentId: params.agentId,
      completedAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.callback.put(updated);

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: callback.uccCallId,
      uccTicketId: callback.uccTicketId,
      type: 'CALLBACK_COMPLETED',
      actor: 'AGENT',
      actorId: params.agentId,
      traceId: call.traceId,
      discriminator: `${callback.id}:completed`,
      payload: { callbackId: callback.id, agentId: params.agentId },
    });

    return updated;
  }

  listCallbacks(tenantId: string) {
    return this.repos.callback.list(tenantId);
  }
}
