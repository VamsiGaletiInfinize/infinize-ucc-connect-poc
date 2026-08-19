import type { FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { UccError } from '@ucc/types';
import type { Container } from '../bootstrap/container.ts';

/** Browser tokens are short-lived: a leaked one stops being useful quickly. */
const TOKEN_TTL_SECONDS = 60 * 60;

/**
 * UCC agent id -> TaskRouter Worker SID.
 *
 * Resolved from TaskRouter by the `ucc_agent_id` attribute rather than stored in seed data
 * or configuration. Worker SIDs are generated when the workspace is provisioned, so
 * hardcoding them would mean the repo drifts the moment anyone re-provisions. Looking them
 * up keeps one source of truth — the workspace itself.
 */
const workerSidCache = new Map<string, string>();

async function resolveWorkerSid(
  client: ReturnType<typeof twilio>,
  workspaceSid: string,
  agentId: string,
): Promise<string | undefined> {
  const cached = workerSidCache.get(agentId);
  if (cached) return cached;

  try {
    const workers = await client.taskrouter.v1
      .workspaces(workspaceSid)
      .workers.list({ limit: 50 });

    for (const w of workers) {
      let attrs: { ucc_agent_id?: string } = {};
      try {
        attrs = JSON.parse(w.attributes ?? '{}');
      } catch {
        continue;
      }
      if (attrs.ucc_agent_id) workerSidCache.set(attrs.ucc_agent_id, w.sid);
    }
  } catch (err) {
    // A TaskRouter outage must not stop an agent registering their phone — they simply
    // lose reservation events until it recovers.
    logger.warn('Could not resolve TaskRouter workers', { error: (err as Error).message });
    return undefined;
  }

  return workerSidCache.get(agentId);
}

/**
 * Agent voice endpoints.
 *
 * The agent's browser becomes a real voice endpoint, so they answer and speak to the
 * caller inside the UCC workspace with the case already on screen — the caller never
 * repeats themselves.
 *
 * Two grants ride on one Access Token:
 *   VoiceGrant       lets the browser register as `client:<agentId>` and take calls
 *   TaskRouterGrant  lets the browser receive reservations and set availability
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY — READ BEFORE DEPLOYING ANYWHERE REAL
 *
 * This endpoint mints a credential that lets the holder answer calls as the named agent
 * and hear whatever the caller says. The UCC API has no end-user authentication yet
 * (a documented POC gap), which means **anyone who can reach this endpoint can mint a
 * token as any agent**. On a laptop behind a tunnel that is contained; exposed publicly it
 * is a live eavesdropping path.
 *
 * Before this leaves a demo machine it needs an authenticated session, and the agent id
 * must come from that session rather than from the URL. The ownership checks elsewhere in
 * UCC are already written against a server-side agent identity, so this is a wiring change
 * rather than a redesign — see docs/security.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function registerAgentVoiceRoutes(app: FastifyInstance, c: Container): void {
  /**
   * Mint a browser voice + TaskRouter token for one agent.
   *
   * Uses an API key pair rather than the account auth token, so the account-wide secret
   * never participates in token signing and can be rotated independently.
   */
  app.post('/api/agents/:id/voice-token', async (request) => {
    const cfg = config();
    const { id } = request.params as { id: string };

    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_API_KEY_SID || !cfg.TWILIO_API_KEY_SECRET) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET are required to mint agent voice tokens.',
        500,
      );
    }
    if (!cfg.TWILIO_TWIML_APP_SID) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'TWILIO_TWIML_APP_SID is required so the browser client can place calls.',
        500,
      );
    }

    // The agent must exist in this tenant. This is not authentication — it only stops a
    // token being minted for an identity UCC does not know.
    const agent = await c.agents.get(c.tenantId, id);

    const { AccessToken } = twilio.jwt;
    const token = new AccessToken(
      cfg.TWILIO_ACCOUNT_SID,
      cfg.TWILIO_API_KEY_SID,
      cfg.TWILIO_API_KEY_SECRET,
      { identity: agent.id, ttl: TOKEN_TTL_SECONDS },
    );

    token.addGrant(
      new AccessToken.VoiceGrant({
        outgoingApplicationSid: cfg.TWILIO_TWIML_APP_SID,
        // Required for the browser to receive the conference leg TaskRouter dials.
        incomingAllow: true,
      }),
    );

    // Prefer a worker id already on the agent record; otherwise resolve it from the
    // workspace, which is authoritative.
    let workerSid = agent.workerSid;
    if (!workerSid && cfg.TWILIO_WORKSPACE_SID) {
      workerSid = await resolveWorkerSid(
        twilio(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN ?? ''),
        cfg.TWILIO_WORKSPACE_SID,
        agent.id,
      );
    }

    if (cfg.TWILIO_WORKSPACE_SID && workerSid) {
      token.addGrant(
        new AccessToken.TaskRouterGrant({
          workspaceSid: cfg.TWILIO_WORKSPACE_SID,
          workerSid,
          role: 'worker',
        }),
      );
    }

    // Never log the token itself.
    logger.info('Minted agent voice token', {
      agentId: agent.id,
      ttlSeconds: TOKEN_TTL_SECONDS,
      taskRouter: workerSid ? 'granted' : 'unavailable',
    });

    return {
      token: token.toJwt(),
      identity: agent.id,
      workerSid: workerSid ?? null,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    };
  });

  /**
   * Voice URL for the TwiML application backing the browser client.
   *
   * Reached when an agent dials out from the workspace. Inbound legs do not come through
   * here — TaskRouter dials the worker's `contact_uri` directly and bridges both parties
   * into a conference.
   */
  app.post('/twilio/voice/agent', async (request, reply) => {
    const cfg = config();
    const body = (request.body ?? {}) as Record<string, string>;
    const response = new twilio.twiml.VoiceResponse();

    const to = body.To?.trim();
    if (!to) {
      response.say({ voice: 'Polly.Aditi' }, 'No destination was provided.');
      response.hangup();
      return reply.type('text/xml').send(response.toString());
    }

    // Agent-initiated outbound: dial the caller from the university's number.
    response.dial({ callerId: cfg.TWILIO_PHONE_NUMBER, record: 'record-from-answer' }).number(to);
    return reply.type('text/xml').send(response.toString());
  });
}
