import type { FastifyInstance, FastifyRequest } from 'fastify';
import twilio from 'twilio';
import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { UccError } from '@ucc/types';
import type { Container } from '../bootstrap/container.ts';

/**
 * Twilio voice integration.
 *
 * Twilio owns telephony, speech-to-text and text-to-speech. UCC owns the conversation:
 * every caller utterance goes through the same `ai.handleTurn` used by the simulated and
 * Amazon Connect paths, so the authorization gate, verification and ticketing behave
 * identically regardless of who is carrying the audio (ADR-0002, ADR-0004).
 *
 * Call shape:
 *
 *   PSTN ──▶ /twilio/voice/inbound   TwiML: open a ConversationRelay session
 *              │                     (also opens the UccCall + UccTicket)
 *              ▼
 *          ws /twilio/relay          prompt ──▶ handleTurn ──▶ text tokens
 *              │
 *              ├─ AI resolves ─────▶ end_session
 *              └─ escalation ──────▶ end_session with handoffData
 *                                        │
 *                                        ▼
 *                     /twilio/voice/handoff  ──▶ TaskRouter enqueue ──▶ agent
 *
 * SECURITY: these endpoints are public, so every HTTP webhook is signature-verified
 * against the Twilio auth token. An unsigned request is rejected before it can create a
 * case or move a call.
 */
export function registerTwilioRoutes(app: FastifyInstance, c: Container): void {
  const cfg = config();

  /**
   * Verify a Twilio webhook signature.
   *
   * Twilio signs the exact URL it called plus the form body. Behind a tunnel or load
   * balancer the host we see is not the host Twilio dialled, so the public base URL is
   * authoritative when configured.
   */
  function assertTwilioSignature(request: FastifyRequest): void {
    const token = cfg.TWILIO_AUTH_TOKEN;
    if (!token) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'TWILIO_AUTH_TOKEN is required to verify Twilio webhooks.',
        500,
      );
    }
    // Explicit opt-out, for local replay of captured payloads only.
    if (process.env.TWILIO_SKIP_SIGNATURE_CHECK === '1') {
      logger.warn('Twilio signature verification DISABLED — do not use outside local testing');
      return;
    }

    const signature = request.headers['x-twilio-signature'];
    const base = cfg.PUBLIC_BASE_URL ?? `https://${request.headers.host}`;
    const url = new URL(request.url, base).toString();

    const valid =
      typeof signature === 'string' &&
      twilio.validateRequest(token, signature, url, (request.body ?? {}) as Record<string, string>);

    if (!valid) {
      logger.warn('Rejected Twilio webhook with invalid signature', { path: request.url });
      throw new UccError('NOT_AUTHORIZED', 'Invalid Twilio signature.', 403);
    }
  }

  const relayWsUrl = (): string => {
    if (!cfg.PUBLIC_BASE_URL) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'PUBLIC_BASE_URL is required so Twilio can reach the ConversationRelay websocket.',
        500,
      );
    }
    return `${cfg.PUBLIC_BASE_URL.replace(/^http/, 'ws')}/twilio/relay`;
  };

  // --- inbound -----------------------------------------------------------

  /**
   * Inbound call answer URL.
   *
   * The case is opened here rather than on the websocket so that a caller who hangs up
   * during the greeting still leaves a UccCall and UccTicket behind — every contact is a
   * case, including abandoned ones (constitution Principle III).
   */
  app.post('/twilio/voice/inbound', async (request, reply) => {
    assertTwilioSignature(request);

    const body = (request.body ?? {}) as Record<string, string>;
    const callSid = body.CallSid;
    const from = body.From;
    if (!callSid || !from) {
      throw new UccError('VALIDATION_FAILED', 'CallSid and From are required.', 400);
    }

    const { call } = await c.calls.startInbound({
      tenantId: c.tenantId,
      providerContactId: callSid,
      callerPhoneNumber: from,
      // Twilio retries webhooks; the CallSid makes the open idempotent.
      providerEventId: `twilio:inbound:${callSid}`,
    });

    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect({
      // Twilio posts here once the session ends, carrying any handoffData.
      action: `${cfg.PUBLIC_BASE_URL}/twilio/voice/handoff`,
    });
    const relay = connect.conversationRelay({
      url: relayWsUrl(),
      welcomeGreeting:
        'Thank you for calling Infinize University. How can I help you today?',
      // Callers must be able to cut in; a voice agent you cannot interrupt feels broken.
      interruptible: 'speech',
      ttsProvider: 'Amazon',
      transcriptionProvider: 'Deepgram',
      language: 'en-IN',
    });
    // Correlation ids arrive back on the websocket setup message.
    relay.parameter({ name: 'uccCallId', value: call.id });
    relay.parameter({ name: 'tenantId', value: call.tenantId });

    reply.type('text/xml').send(response.toString());
  });

  /**
   * Outbound answer URL. The correlation ids were placed on the query string when the call
   * was created, because Twilio has no equivalent of Connect's contact attributes.
   */
  app.post('/twilio/voice/outbound', async (request, reply) => {
    assertTwilioSignature(request);

    const q = request.query as Record<string, string | undefined>;
    const response = new twilio.twiml.VoiceResponse();
    const connect = response.connect({
      action: `${cfg.PUBLIC_BASE_URL}/twilio/voice/handoff`,
    });
    const relay = connect.conversationRelay({
      url: relayWsUrl(),
      welcomeGreeting:
        'Hello, this is Infinize University calling about your application. Is now a good time?',
      interruptible: 'speech',
      ttsProvider: 'Amazon',
      language: 'en-IN',
    });
    if (q.uccCallId) relay.parameter({ name: 'uccCallId', value: q.uccCallId });
    if (q.tenantId) relay.parameter({ name: 'tenantId', value: q.tenantId });

    reply.type('text/xml').send(response.toString());
  });

  // --- the conversation --------------------------------------------------

  /**
   * ConversationRelay websocket.
   *
   * Twilio sends `prompt` messages containing transcribed speech; we reply with `text`
   * tokens which Twilio speaks. Replies are streamed token by token so the caller hears
   * the first words while the rest is still being generated — without that the pause after
   * every sentence is long enough to feel broken.
   */
  app.get('/twilio/relay', { websocket: true }, (socket) => {
    let uccCallId: string | undefined;
    let tenantId: string | undefined;
    let callSid: string | undefined;
    /** Guards against overlapping turns when a caller talks over the reply. */
    let turnInFlight = false;

    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const speak = (token: string, last = false) => send({ type: 'text', token, last });

    socket.on('message', async (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        logger.warn('ConversationRelay sent unparseable frame');
        return;
      }

      switch (msg.type) {
        case 'setup': {
          const params = (msg.customParameters ?? {}) as Record<string, string>;
          uccCallId = params.uccCallId;
          tenantId = params.tenantId ?? c.tenantId;
          callSid = msg.callSid as string;
          logger.info('ConversationRelay session started', { uccCallId, callSid });
          return;
        }

        case 'prompt': {
          // Field name differs across Twilio doc revisions; accept either.
          const utterance = String(msg.text ?? msg.voicePrompt ?? '').trim();
          // Partial transcripts arrive with last=false; only act on the finished utterance.
          if (!utterance || msg.last === false) return;
          if (!uccCallId) {
            logger.warn('Prompt before setup — no UccCall bound to this session');
            return;
          }
          if (turnInFlight) {
            logger.info('Dropping overlapping prompt while a turn is in flight', { uccCallId });
            return;
          }

          turnInFlight = true;
          try {
            await handleTurnStreaming({
              container: c,
              tenantId: tenantId ?? c.tenantId,
              uccCallId,
              utterance,
              onToken: (t) => speak(t),
              onComplete: (result) => {
                speak('', true);
                if (result.escalated) {
                  // Twilio posts handoffData to the action URL, where routing happens.
                  send({
                    type: 'end_session',
                    handoffData: JSON.stringify({
                      reason: 'ESCALATED',
                      uccCallId,
                      uccTicketId: result.ticketId,
                      departmentId: result.departmentId,
                    }),
                  });
                }
              },
            });
          } catch (err) {
            // Never invent an answer when the AI path fails — say so and escalate.
            logger.error('Turn failed on ConversationRelay', {
              uccCallId,
              error: (err as Error).message,
            });
            speak('I am having trouble reaching our systems. Let me pass you to a colleague.', true);
            send({
              type: 'end_session',
              handoffData: JSON.stringify({ reason: 'AI_FAILURE', uccCallId }),
            });
          } finally {
            turnInFlight = false;
          }
          return;
        }

        case 'interrupt': {
          logger.info('Caller interrupted the assistant', { uccCallId });
          return;
        }

        case 'error': {
          logger.error('ConversationRelay reported an error', {
            uccCallId,
            errorCode: msg.errorCode,
            errorMessage: msg.errorMessage,
          });
          return;
        }

        default:
          return;
      }
    });

    socket.on('close', () => {
      logger.info('ConversationRelay session closed', { uccCallId, callSid });
    });
  });

  // --- handoff and lifecycle ---------------------------------------------

  /**
   * Session-ended action URL.
   *
   * Reached when the AI ends the session. If it ended because of an escalation, the call is
   * still live: it is enqueued to TaskRouter, which selects the agent. UCC supplies only
   * the department.
   */
  app.post('/twilio/voice/handoff', async (request, reply) => {
    assertTwilioSignature(request);

    const body = (request.body ?? {}) as Record<string, string>;
    const response = new twilio.twiml.VoiceResponse();

    let handoff: { reason?: string; uccCallId?: string; departmentId?: string } = {};
    try {
      handoff = body.HandoffData ? JSON.parse(body.HandoffData) : {};
    } catch {
      logger.warn('Unparseable HandoffData from ConversationRelay');
    }

    if (handoff.reason === 'ESCALATED' || handoff.reason === 'AI_FAILURE') {
      response.say(
        { voice: 'Polly.Aditi' },
        'Please hold while I connect you to the next available adviser.',
      );
      // TaskRouter owns queueing and agent selection.
      response.enqueue({ workflowSid: cfg.TWILIO_WORKFLOW_SID }).task(
        JSON.stringify({
          department: handoff.departmentId ?? 'dept-general',
          ucc_call_id: handoff.uccCallId,
          type: 'voice',
        }),
      );
    } else {
      response.say({ voice: 'Polly.Aditi' }, 'Thank you for calling Infinize University. Goodbye.');
      response.hangup();
    }

    reply.type('text/xml').send(response.toString());
  });

  /** Call progress events, normalized onto the UCC timeline. */
  app.post('/twilio/voice/status', async (request, reply) => {
    assertTwilioSignature(request);

    const body = (request.body ?? {}) as Record<string, string>;
    const callSid = body.CallSid;
    const status = body.CallStatus;

    if (callSid && (status === 'completed' || status === 'no-answer' || status === 'failed')) {
      const call = await c.repos.call.byProviderContactId(c.tenantId, callSid).catch(() => null);
      if (call && !call.endedAt) {
        await c.calls.endCall({
          tenantId: c.tenantId,
          callId: call.id,
          reason: status === 'completed' ? 'COMPLETED' : 'FAILED',
          providerEventId: `twilio:status:${callSid}:${status}`,
        });
      }
    }

    reply.code(204).send();
  });
}

/**
 * Run one turn, streaming tokens out as they are produced.
 *
 * Streaming is deliberately isolated here rather than pushed into the AI service: the tool
 * loop must complete before the model's final answer exists, so only the closing message is
 * streamable. Attempting to stream through tool execution would speak half-formed answers
 * that a denied authorization check should have prevented.
 */
async function handleTurnStreaming(params: {
  container: Container;
  tenantId: string;
  uccCallId: string;
  utterance: string;
  onToken: (token: string) => void;
  onComplete: (r: { escalated: boolean; ticketId: string; departmentId?: string }) => void;
}): Promise<void> {
  const { container: c, tenantId, uccCallId, utterance, onToken, onComplete } = params;

  const call = await c.calls.get(tenantId, uccCallId);
  const ticket = await c.repos.ticket.byCallId(tenantId, uccCallId);
  if (!ticket) throw new UccError('NOT_FOUND', `No case for call ${uccCallId}`, 404);

  const result = await c.ai.handleTurn({ call, ticket, utterance });

  // Chunk on word boundaries so Twilio's TTS receives natural units rather than fragments.
  for (const chunk of result.reply.match(/\S+\s*/g) ?? [result.reply]) {
    onToken(chunk);
  }

  onComplete({
    escalated: result.escalated,
    ticketId: result.ticket.id,
    departmentId: result.ticket.departmentId,
  });
}
