import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UccError } from '@ucc/types';
import type { Container } from '../bootstrap/container.ts';

/**
 * University application APIs — protected transactional data.
 *
 * DESIGN DECISION: every endpoint requires a `callId`. Verification is bound to a single
 * contact, so authorization can only be evaluated in the context of a call. An endpoint
 * that answered without one would either have no security context at all or would invent
 * a session — both unacceptable. The security context is rebuilt server-side from the
 * call's persisted verification state on every request.
 */
export function registerApplicationRoutes(app: FastifyInstance, c: Container): void {
  const query = z.object({ callId: z.string().min(1) });

  async function contextFor(callId: string) {
    const call = await c.calls.get(c.tenantId, callId);
    const ticket = await c.repos.ticket.byCallId(c.tenantId, callId);
    if (!ticket) throw new UccError('NOT_FOUND', `No case for call ${callId}`, 404);
    return c.identity.buildSecurityContext(call, ticket.id);
  }

  /** Applications the verified caller on this contact may see. */
  app.get('/api/applications', async (request) => {
    const { callId } = query.parse(request.query);
    const ctx = await contextFor(callId);
    const applications = await c.applications.listForContact(ctx);
    return { applications, verified: ctx.verified };
  });

  /**
   * One application's full detail.
   * `:id` is the application number, e.g. APP-2026-001.
   */
  app.get('/api/applications/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { callId } = query.parse(request.query);
    const ctx = await contextFor(callId);
    return c.applications.getStatusForContact(ctx, id);
  });

  app.get('/api/applications/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    const { callId } = query.parse(request.query);
    const ctx = await contextFor(callId);
    const view = await c.applications.getStatusForContact(ctx, id);
    return {
      applicationId: view.applicationId,
      program: view.program,
      status: view.status,
      lastUpdatedAt: view.lastUpdatedAt,
    };
  });
}
