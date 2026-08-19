import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '@ucc/shared';
import { UccError } from '@ucc/types';
import type { Container } from '../bootstrap/container.ts';

/**
 * Bridge for an external voice pipeline (Pipecat + Amazon Nova Sonic).
 *
 * When speech-to-speech runs outside this process the MODEL moves, but authorization,
 * tool logic and the tool catalogue must not. These two endpoints are the only way in:
 *
 *   GET  /api/ai/tools           the one tool catalogue, so the pipeline never keeps a copy
 *   POST /api/calls/:id/tool     execute a tool through the real gate
 *
 * The security context is rebuilt from persisted state inside `executeToolForCall`, so an
 * unverified caller is refused no matter which model asked (ADR-0002). Pipecat cannot grant
 * itself access by asserting anything — it has nothing to assert with.
 *
 * SECURITY: this endpoint executes privileged tools and is reachable by whatever can call
 * the API. It carries the same missing-authentication gap as the rest of the POC surface
 * (see docs/security.md); before any shared deployment it needs a service credential shared
 * with the Pipecat service, and the call id must be bound to that session.
 */
export function registerVoiceBridgeRoutes(app: FastifyInstance, c: Container): void {
  /** The tool catalogue, verbatim from the AI service. Single source of truth. */
  app.get('/api/ai/tools', async () => ({ tools: c.ai.toolSpecs() }));

  const toolCallSchema = z.object({
    name: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  });

  app.post('/api/calls/:id/tool', async (request) => {
    const { id } = request.params as { id: string };
    const { name, input } = toolCallSchema.parse(request.body);

    const call = await c.calls.get(c.tenantId, id);
    const ticket = await c.repos.ticket.byCallId(c.tenantId, id);
    if (!ticket) throw new UccError('NOT_FOUND', `No case for call ${id}`, 404);

    const { result, ticket: updated } = await c.ai.executeToolForCall({
      call,
      ticket,
      name,
      input: input as Record<string, unknown>,
    });

    logger.info('Voice bridge tool executed', {
      uccCallId: id,
      tool: name,
      ok: result.ok,
      control: result.control,
    });

    return {
      ok: result.ok,
      data: result.data,
      control: result.control ?? null,
      // The pipeline needs these to decide whether to end the session and hand off.
      escalated: result.control === 'ESCALATED',
      ticketStatus: updated.status,
      departmentId: updated.departmentId ?? null,
      assignedAgentId: updated.assignedAgentId ?? null,
    };
  });
}
