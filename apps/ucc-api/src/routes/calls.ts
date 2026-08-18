import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UccError } from '@ucc/types';
import type { Container } from '../bootstrap/container.ts';

/**
 * Contact lifecycle endpoints.
 *
 * `POST /api/calls/inbound` is the UCC-side ingestion point for a provider contact event.
 * With a live Amazon Connect instance this is invoked by the contact flow's Lambda
 * integration; in the simulated configuration the demo console posts to it directly. The
 * payload shape is the provider-neutral `InboundContactEvent`, so the code path is
 * identical either way.
 */
export function registerCallRoutes(app: FastifyInstance, c: Container): void {
  const inboundSchema = z.object({
    callerPhoneNumber: z.string().min(5),
    providerContactId: z.string().optional(),
    providerEventId: z.string().optional(),
  });

  app.post('/api/calls/inbound', async (request, reply) => {
    const body = inboundSchema.parse(request.body);
    const providerContactId = body.providerContactId ?? crypto.randomUUID();

    const { call, ticket, created } = await c.calls.startInbound({
      tenantId: c.tenantId,
      providerContactId,
      callerPhoneNumber: body.callerPhoneNumber,
      providerEventId: body.providerEventId,
    });

    const greeting = created ? await c.ai.greet(call, ticket) : null;

    return reply.code(created ? 201 : 200).send({ call, ticket, greeting, created });
  });

  app.get('/api/calls', async () => {
    const calls = await c.calls.list(c.tenantId);
    return calls.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  });

  app.get('/api/calls/:id', async (request) => {
    const { id } = request.params as { id: string };
    const call = await c.calls.get(c.tenantId, id);
    const [ticket, timeline, transcript] = await Promise.all([
      c.repos.ticket.byCallId(c.tenantId, id),
      c.events.timelineForCall(c.tenantId, id),
      c.transcripts.byCall(c.tenantId, id),
    ]);
    return { call, ticket, timeline, transcript };
  });

  /** One caller utterance through the AI orchestrator. */
  const turnSchema = z.object({ utterance: z.string().min(1).max(2000) });

  app.post('/api/calls/:id/turn', async (request) => {
    const { id } = request.params as { id: string };
    const { utterance } = turnSchema.parse(request.body);

    const call = await c.calls.get(c.tenantId, id);
    const ticket = await c.repos.ticket.byCallId(c.tenantId, id);
    if (!ticket) throw new UccError('NOT_FOUND', `No case for call ${id}`, 404);

    const result = await c.ai.handleTurn({ call, ticket, utterance });
    return {
      reply: result.reply,
      toolsUsed: result.toolsUsed,
      escalated: result.escalated,
      callbackCreated: result.callbackCreated,
      ticket: result.ticket,
    };
  });

  /** Mark the case resolved by the AI without human involvement. */
  const resolveSchema = z.object({ summary: z.string().min(1).max(1000) });

  app.post('/api/calls/:id/ai-resolve', async (request) => {
    const { id } = request.params as { id: string };
    const { summary } = resolveSchema.parse(request.body);
    const call = await c.calls.get(c.tenantId, id);
    const ticket = await c.repos.ticket.byCallId(c.tenantId, id);
    if (!ticket) throw new UccError('NOT_FOUND', `No case for call ${id}`, 404);
    return c.ai.resolveByAi(call, ticket, summary);
  });

  const endSchema = z.object({
    reason: z.enum(['COMPLETED', 'ABANDONED', 'FAILED']).optional(),
    providerEventId: z.string().optional(),
  });

  app.post('/api/calls/:id/end', async (request) => {
    const { id } = request.params as { id: string };
    const body = endSchema.parse(request.body ?? {});
    const call = await c.calls.endCall({
      tenantId: c.tenantId,
      callId: id,
      reason: body.reason,
      providerEventId: body.providerEventId,
    });

    const ticket = await c.repos.ticket.byCallId(c.tenantId, id);
    if (ticket) {
      await c.transcripts.finalize(call, ticket.id);

      // Recording metadata. With a live Connect instance this comes from the Contact
      // Trace Record; without one, no audio exists and none is invented.
      if (c.telephony.isLive()) {
        const location = await c.telephony.getRecordingLocation({
          providerContactId: call.providerContactId,
        });
        if (location) {
          await c.recordings.registerFromProvider({
            call,
            uccTicketId: ticket.id,
            storageLocation: location.storageLocation,
            duration: location.duration,
          });
        }
      }
    }

    return { call, ticket };
  });

  /** Explicit verification submission from the demo console (mirrors the AI tool path). */
  const verifySchema = z.object({ code: z.string().min(1).max(12) });

  app.post('/api/calls/:id/verify', async (request) => {
    const { id } = request.params as { id: string };
    const { code } = verifySchema.parse(request.body);

    const call = await c.calls.get(c.tenantId, id);
    const ticket = await c.repos.ticket.byCallId(c.tenantId, id);
    if (!ticket) throw new UccError('NOT_FOUND', `No case for call ${id}`, 404);

    const session = await c.verification.activeSession(c.tenantId, id);
    if (!session) {
      throw new UccError('VALIDATION_FAILED', 'No verification is in progress on this call', 400);
    }

    const result = await c.verification.verify({
      tenantId: c.tenantId,
      uccCallId: id,
      uccTicketId: ticket.id,
      sessionId: session.id,
      code,
      traceId: call.traceId,
    });

    if (result.verified) {
      await c.tickets.setVerificationStatus(c.tenantId, ticket.id, 'VERIFIED');
    }
    return result;
  });
}
