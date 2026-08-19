import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '@ucc/config';
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
  const cfg = config();

  /**
   * Prove the caller is the voice pipeline.
   *
   * Compared in constant time: a shared secret checked with `===` leaks its prefix to
   * anyone willing to measure, and this secret guards privileged tool execution.
   */
  function assertServiceCredential(request: FastifyRequest): void {
    const expected = cfg.UCC_VOICE_SERVICE_TOKEN;
    if (!expected) {
      // No credential configured means the channel cannot be closed. Refuse rather than
      // serve it open, which is the whole point of this change.
      throw new UccError(
        'CONFIGURATION_ERROR',
        'UCC_VOICE_SERVICE_TOKEN is not configured; the voice bridge refuses to serve an unauthenticated channel.',
        500,
      );
    }

    const header = request.headers.authorization;
    const presented = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';

    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      logger.warn('Rejected voice bridge request with invalid service credential', {
        path: request.url,
      });
      throw new UccError('NOT_AUTHORIZED', 'Invalid service credential.', 401);
    }
  }

  /**
   * Prove this stream may act on this case.
   *
   * The service credential alone would authenticate the *service* but not the *session*, so
   * any holder could read any case by guessing a call id. That is the server-side
   * authorization property reopened one layer down, which is why both are required
   * (FR-027, FR-028, ADR-0008).
   */
  async function assertSessionBinding(request: FastifyRequest, uccCallId: string): Promise<void> {
    const token = request.headers['x-ucc-session-token'];
    if (typeof token !== 'string' || !token) {
      throw new UccError('NOT_AUTHORIZED', 'Missing session token.', 401);
    }

    const check = await c.sessionTokens.check({
      tenantId: c.tenantId,
      uccCallId,
      token,
    });

    if (!check.ok) {
      // Log the reason but never the token. A cross-case attempt is worth seeing.
      logger.warn('Rejected voice bridge request with unusable session token', {
        uccCallId,
        reason: check.reason,
      });
      throw new UccError('NOT_AUTHORIZED', 'Session token is not valid for this call.', 403);
    }
  }

  /**
   * The tool catalogue, verbatim from the AI service. Single source of truth.
   *
   * Service credential only: the catalogue is not case-specific, and the pipeline needs it
   * before it has done anything with a call.
   */
  app.get('/api/ai/tools', async (request) => {
    assertServiceCredential(request);
    return { tools: c.ai.toolSpecs() };
  });

  const toolCallSchema = z.object({
    name: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  });

  app.post('/api/calls/:id/tool', async (request) => {
    const { id } = request.params as { id: string };

    // Both credentials, before anything else touches a case. Ordered service-then-session
    // so an unauthenticated caller learns nothing about whether a call id exists.
    assertServiceCredential(request);
    await assertSessionBinding(request, id);

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
