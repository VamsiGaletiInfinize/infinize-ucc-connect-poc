import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OPEN_TICKET_STATUSES } from '@ucc/types';
import type { Container } from '../bootstrap/container.ts';

/** Agents, queues, knowledge, outbound, callbacks, supervisor and demo controls. */
export function registerOperationRoutes(app: FastifyInstance, c: Container): void {
  // --- agents -------------------------------------------------------------

  app.get('/api/agents', async () => c.agents.list(c.tenantId));

  const statusSchema = z.object({
    status: z.enum(['AVAILABLE', 'ON_CALL', 'AFTER_CALL_WORK', 'BREAK', 'OFFLINE']),
  });

  app.post('/api/agents/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    const { status } = statusSchema.parse(request.body);
    return c.agents.setStatus(c.tenantId, id, status);
  });

  // --- queues -------------------------------------------------------------

  app.get('/api/queues', async () => c.routing.queueSnapshot(c.tenantId));

  app.get('/api/departments', async () => c.repos.department.list(c.tenantId));

  // --- knowledge ----------------------------------------------------------

  app.get('/api/knowledge', async () => ({
    documents: await c.knowledge.documents(),
    retrieval: c.knowledge.isLexicalFallback() ? 'LEXICAL_FALLBACK' : 'BEDROCK_EMBEDDINGS',
    chunks: c.knowledge.size(),
    healthy: !(await isKbFailing(c)),
  }));

  const searchSchema = z.object({ query: z.string().min(1).max(500), topK: z.number().optional() });

  app.post('/api/knowledge/search', async (request) => {
    const body = searchSchema.parse(request.body);
    const hits = await c.knowledge.search(body.query, body.topK ?? 4);
    return { hits };
  });

  // --- outbound -----------------------------------------------------------

  app.get('/api/campaigns', async () => c.outbound.list(c.tenantId));

  app.post('/api/campaigns', async (_request, reply) => {
    const campaign = await c.outbound.createDeadlineReminderCampaign(c.tenantId);
    return reply.code(201).send(campaign);
  });

  app.post('/api/campaigns/:id/run', async (request) => {
    const { id } = request.params as { id: string };
    const result = await c.outbound.runCampaign(c.tenantId, id);
    return {
      campaign: result.campaign,
      contacts: result.contacts.map((x) => ({
        callId: x.call.id,
        ticketId: x.ticket.id,
        ticketNumber: x.ticket.ticketNumber,
        phone: x.call.callerId,
        opening: x.opening,
      })),
    };
  });

  // --- callbacks ----------------------------------------------------------

  app.get('/api/callbacks', async () => c.routing.listCallbacks(c.tenantId));

  const completeSchema = z.object({ agentId: z.string().min(1) });

  app.post('/api/callbacks/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    const { agentId } = completeSchema.parse(request.body);
    return c.routing.completeCallback({ tenantId: c.tenantId, callbackId: id, agentId });
  });

  // --- supervisor ---------------------------------------------------------

  app.get('/api/supervisor/dashboard', async () => {
    const [calls, tickets, agents, queues, callbacks] = await Promise.all([
      c.calls.list(c.tenantId),
      c.tickets.list(c.tenantId),
      c.agents.list(c.tenantId),
      c.routing.queueSnapshot(c.tenantId),
      c.routing.listCallbacks(c.tenantId),
    ]);

    const activeCalls = calls.filter((x) => !x.endedAt);
    const openTickets = tickets.filter((t) => OPEN_TICKET_STATUSES.includes(t.status));

    return {
      metrics: {
        activeCalls: activeCalls.length,
        aiCalls: activeCalls.filter((x) => x.status === 'AI_HANDLING').length,
        agentCalls: activeCalls.filter((x) => x.status === 'AGENT_CONNECTED').length,
        waitingCalls: activeCalls.filter((x) => x.status === 'QUEUED').length,
        availableAgents: agents.filter((a) => a.status === 'AVAILABLE').length,
        busyAgents: agents.filter((a) => a.status === 'ON_CALL').length,
        escalations: tickets.filter(
          (t) =>
            t.status === 'ESCALATED' ||
            t.status === 'QUEUED_FOR_AGENT' ||
            t.status === 'AGENT_ASSIGNED' ||
            t.status === 'AGENT_HANDLING',
        ).length,
        openTickets: openTickets.length,
        aiResolved: tickets.filter((t) => t.status === 'AI_RESOLVED').length,
        resolvedToday: tickets.filter((t) => t.status === 'RESOLVED' || t.status === 'CLOSED')
          .length,
        pendingCallbacks: callbacks.filter((x) => x.status === 'QUEUED').length,
      },
      queues,
      // Live floor.
      agents: await Promise.all(
        agents.map(async (a) => {
          const currentCall = a.currentCallId
            ? await c.repos.call.get(c.tenantId, a.currentCallId)
            : null;
          const currentTicket = a.currentCallId
            ? await c.repos.ticket.byCallId(c.tenantId, a.currentCallId)
            : null;
          const departments = await c.repos.department.list(c.tenantId);
          return {
            id: a.id,
            name: `${a.firstName} ${a.lastName}`,
            status: a.status,
            routingProfile: a.routingProfileName,
            departments: a.departmentIds
              .map((d) => departments.find((x) => x.id === d)?.name)
              .filter(Boolean),
            currentCallId: a.currentCallId ?? null,
            currentTicketNumber: currentTicket?.ticketNumber ?? null,
            currentCallerType: currentCall?.callerType ?? null,
          };
        }),
      ),
      activeCalls: await Promise.all(
        activeCalls.map(async (call) => {
          const ticket = await c.repos.ticket.byCallId(c.tenantId, call.id);
          const department = call.departmentId
            ? await c.repos.department.get(c.tenantId, call.departmentId)
            : null;
          return {
            callId: call.id,
            ticketId: ticket?.id ?? null,
            ticketNumber: ticket?.ticketNumber ?? null,
            direction: call.direction,
            callerType: call.callerType,
            callerId: call.callerId,
            status: call.status,
            ticketStatus: ticket?.status ?? null,
            department: department?.name ?? null,
            startedAt: call.startedAt,
          };
        }),
      ),
    };
  });

  // --- demo controls ------------------------------------------------------

  /**
   * Failure injection for the resilience demo scenarios.
   * Proves the system escalates rather than fabricating when a dependency is down.
   */
  const failureSchema = z.object({
    target: z.enum(['knowledge', 'applications']),
    enabled: z.boolean(),
  });

  app.post('/api/demo/failure-mode', async (request) => {
    const { target, enabled } = failureSchema.parse(request.body);
    if (target === 'knowledge') c.knowledge.setFailureMode(enabled);
    else c.applications.setFailureMode(enabled);
    return { target, enabled };
  });

  app.get('/api/demo/state', async () => ({
    tenantId: c.tenantId,
    telephony: { provider: c.telephony.name, live: c.telephony.isLive() },
    retrieval: c.knowledge.isLexicalFallback() ? 'LEXICAL_FALLBACK' : 'BEDROCK_EMBEDDINGS',
    knowledgeFailing: await isKbFailing(c),
    applicationsFailing: c.applications.isFailing(),
    callers: (await c.repos.caller.list(c.tenantId)).map((x) => ({
      id: x.id,
      name: `${x.firstName} ${x.lastName}`,
      phone: x.phone,
      callerType: x.callerType,
      studentId: x.studentId,
    })),
  }));
}

async function isKbFailing(c: Container): Promise<boolean> {
  try {
    await c.knowledge.search('health check', 1);
    return false;
  } catch {
    return true;
  }
}
