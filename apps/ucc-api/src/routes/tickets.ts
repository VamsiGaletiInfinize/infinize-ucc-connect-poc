import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../bootstrap/container.ts';

/**
 * Ticket endpoints.
 *
 * NOTE (FR-003): there is deliberately NO endpoint that sets `status` directly. The
 * frontend calls intent-revealing operations — accept, resolve, close — and the backend
 * maps each onto a guarded state-machine transition. A client cannot drive a ticket into
 * an arbitrary state.
 */
export function registerTicketRoutes(app: FastifyInstance, c: Container): void {
  app.get('/api/tickets', async () => {
    const tickets = await c.tickets.list(c.tenantId);
    return tickets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  /** Full case detail: everything the ticket page renders. */
  app.get('/api/tickets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const ticket = await c.tickets.get(c.tenantId, id);

    const [call, timeline, transcript, department, caller, agent] = await Promise.all([
      c.repos.call.get(c.tenantId, ticket.uccCallId),
      c.events.timelineForTicket(c.tenantId, ticket.id),
      c.transcripts.byCall(c.tenantId, ticket.uccCallId),
      ticket.departmentId ? c.repos.department.get(c.tenantId, ticket.departmentId) : null,
      c.repos.caller.get(c.tenantId, ticket.callerId),
      ticket.assignedAgentId ? c.repos.agent.get(c.tenantId, ticket.assignedAgentId) : null,
    ]);

    const recordings = await c.recordings.list(c.tenantId);
    const recording = recordings.find((r) => r.uccCallId === ticket.uccCallId) ?? null;

    // Agent-facing application context. Disclosure to the CALLER still requires caller
    // verification; this surface is for authenticated staff.
    const applications = caller?.studentId
      ? (await c.repos.application.byStudent(c.tenantId, caller.studentId)).map((a) => ({
          applicationId: a.applicationId,
          program: a.program,
          term: a.term,
          status: a.status,
          outstandingFee: a.outstandingFee,
          scholarshipStatus: a.scholarshipStatus,
          documents: a.documents,
        }))
      : [];

    return {
      ticket,
      call,
      department,
      caller,
      agent,
      timeline,
      transcript,
      recording,
      // Shown when no live telephony instance exists, so the UI can label it honestly.
      recordingPlannedLocation: call ? c.recordings.plannedLocation(call) : null,
      recordingAvailable: Boolean(recording),
      applications,
    };
  });

  const noteSchema = z.object({ agentId: z.string().min(1), body: z.string().min(1).max(4000) });

  app.post('/api/tickets/:id/notes', async (request) => {
    const { id } = request.params as { id: string };
    const body = noteSchema.parse(request.body);
    return c.agents.addNote({
      tenantId: c.tenantId,
      ticketId: id,
      agentId: body.agentId,
      body: body.body,
    });
  });

  const acceptSchema = z.object({ agentId: z.string().min(1) });

  app.post('/api/tickets/:id/accept', async (request) => {
    const { id } = request.params as { id: string };
    const { agentId } = acceptSchema.parse(request.body);
    return c.agents.acceptTicket({ tenantId: c.tenantId, ticketId: id, agentId });
  });

  const resolveSchema = z.object({
    agentId: z.string().min(1),
    resolution: z.string().min(1).max(4000),
  });

  app.post('/api/tickets/:id/resolve', async (request) => {
    const { id } = request.params as { id: string };
    const body = resolveSchema.parse(request.body);
    return c.agents.resolveTicket({
      tenantId: c.tenantId,
      ticketId: id,
      agentId: body.agentId,
      resolution: body.resolution,
    });
  });

  const closeSchema = z.object({ agentId: z.string().optional() });

  app.post('/api/tickets/:id/close', async (request) => {
    const { id } = request.params as { id: string };
    const body = closeSchema.parse(request.body ?? {});
    return c.agents.closeTicket({ tenantId: c.tenantId, ticketId: id, agentId: body.agentId });
  });

  /** Agent workspace payload. */
  app.get('/api/tickets/:id/workspace', async (request) => {
    const { id } = request.params as { id: string };
    return c.agents.workspaceContext(c.tenantId, id);
  });
}
