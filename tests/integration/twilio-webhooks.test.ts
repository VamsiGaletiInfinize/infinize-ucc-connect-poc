import { beforeEach, describe, expect, it } from 'vitest';
import twilio from 'twilio';
import type { FastifyInstance } from 'fastify';
import { resetConfig } from '@ucc/config';
import { createHarness, PHONE, startCall, type TestHarness } from '../helpers.ts';
import { createServer } from '../../apps/ucc-api/src/server.ts';

/**
 * The Twilio webhooks are internet-facing: anyone who finds the URL can POST to them.
 * These tests pin the two properties that matter most.
 *
 *   1. An unsigned or wrongly-signed request cannot open a case or move a call.
 *   2. A signed inbound call produces valid TwiML that starts a ConversationRelay session
 *      and carries the UCC correlation ids, without which a call cannot be traced.
 */

const AUTH_TOKEN = 'test-auth-token';
const BASE = 'https://ucc.example.test';

/** Sign a form body exactly as Twilio does, so the route's own verification is exercised. */
function sign(url: string, params: Record<string, string>): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
}

async function post(
  app: FastifyInstance,
  path: string,
  params: Record<string, string>,
  opts: { signed: boolean } = { signed: true },
) {
  const url = `${BASE}${path}`;
  return app.inject({
    method: 'POST',
    url: path,
    payload: new URLSearchParams(params).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(opts.signed ? { 'x-twilio-signature': sign(url, params) } : {}),
    },
  });
}

describe('Twilio voice webhooks', () => {
  let h: TestHarness;
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PUBLIC_BASE_URL = BASE;
    delete process.env.TWILIO_SKIP_SIGNATURE_CHECK;
    // Default routing for this suite; individual tests override and reset.
    process.env.UCC_ROUTING = 'ucc';
    resetConfig();

    h = await createHarness();
    app = await createServer(h);
    await app.ready();
  });

  it('rejects an unsigned inbound webhook and opens no case', async () => {
    const before = (await h.repos.call.list(h.tenantId)).length;

    const res = await post(
      app,
      '/twilio/voice/inbound',
      { CallSid: 'CA_forged', From: PHONE.applicantTwoApps, To: '+15550000000' },
      { signed: false },
    );

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AUTHORIZED');
    // The important half: nothing was created as a side effect.
    expect((await h.repos.call.list(h.tenantId)).length).toBe(before);
  });

  it('rejects a request signed for a different body', async () => {
    const url = `${BASE}/twilio/voice/inbound`;
    const res = await app.inject({
      method: 'POST',
      url: '/twilio/voice/inbound',
      payload: new URLSearchParams({ CallSid: 'CA_tampered', From: PHONE.student }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Signature computed over different parameters than those actually sent.
        'x-twilio-signature': sign(url, { CallSid: 'CA_original', From: PHONE.student }),
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('opens a UccCall and UccTicket and returns ConversationRelay TwiML', async () => {
    const res = await post(app, '/twilio/voice/inbound', {
      CallSid: 'CA_inbound_1',
      From: PHONE.applicantTwoApps,
      To: '+15550000000',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');

    const xml = res.body;
    expect(xml).toContain('<Connect');
    expect(xml).toContain('<ConversationRelay');
    // Twilio requires a secure websocket; an http URL would silently fail at call time.
    expect(xml).toMatch(/url="wss:\/\//);
    // Callers must be able to interrupt.
    expect(xml).toContain('interruptible="speech"');

    // The case exists and is bound to the Twilio CallSid.
    const call = await h.repos.call.byProviderContactId(h.tenantId, 'CA_inbound_1');
    expect(call).toBeTruthy();
    const ticket = await h.repos.ticket.byCallId(h.tenantId, call!.id);
    expect(ticket).toBeTruthy();

    // Correlation ids ride on the TwiML so the websocket can bind to the case.
    expect(xml).toContain(call!.id);
  });

  it('is idempotent when Twilio retries the same inbound webhook', async () => {
    const params = { CallSid: 'CA_retry', From: PHONE.student, To: '+15550000000' };
    await post(app, '/twilio/voice/inbound', params);
    await post(app, '/twilio/voice/inbound', params);

    const calls = (await h.repos.call.list(h.tenantId)).filter(
      (x) => x.providerContactId === 'CA_retry',
    );
    expect(calls).toHaveLength(1);
  });

  describe('escalation handoff — UCC owns routing (default)', () => {
    it('dials the specific agent UCC already assigned', async () => {
      // Drive a real escalation so the ticket carries a genuine assignment.
      const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'CA_ucc_route');
      const result = await h.routing.escalate({
        tenantId: h.tenantId,
        uccCallId: call.id,
        uccTicketId: ticket.id,
        category: 'ADMISSIONS_SUPPORT',
        reason: 'wants an adviser',
        traceId: call.traceId,
      });
      expect(result.agent).toBeTruthy();

      const res = await post(app, '/twilio/voice/handoff', {
        CallSid: 'CA_ucc_route',
        HandoffData: JSON.stringify({ reason: 'ESCALATED', uccCallId: call.id }),
      });

      const xml = res.body;
      // The caller is bridged to the person UCC chose — no queue indirection.
      expect(xml).toContain('<Dial');
      expect(xml).toContain(`<Client>${result.agent!.id}</Client>`);
      expect(xml).not.toContain('<Enqueue');
      // A ringing browser nobody answers must not strand the caller.
      expect(xml).toMatch(/timeout="\d+"/);
    });

    it('tells the caller the truth when no agent is free', async () => {
      for (const a of await h.repos.agent.list(h.tenantId)) {
        await h.agents.setStatus(h.tenantId, a.id, 'OFFLINE');
      }
      const { call, ticket } = await startCall(h, PHONE.student, 'CA_none_free');
      await h.routing.escalate({
        tenantId: h.tenantId,
        uccCallId: call.id,
        uccTicketId: ticket.id,
        category: 'ADMISSIONS_SUPPORT',
        reason: 'nobody free',
        traceId: call.traceId,
      });

      const res = await post(app, '/twilio/voice/handoff', {
        CallSid: 'CA_none_free',
        HandoffData: JSON.stringify({ reason: 'ESCALATED', uccCallId: call.id }),
      });

      expect(res.body).toMatch(/call you back/i);
      expect(res.body).toContain('<Hangup');
      expect(res.body).not.toContain('<Dial');
    });
  });

  describe('escalation handoff — TaskRouter owns routing', () => {
    beforeEach(async () => {
      process.env.UCC_ROUTING = 'taskrouter';
      process.env.TWILIO_WORKFLOW_SID = 'WW_test';
      resetConfig();
      app = await createServer(h);
      await app.ready();
    });

    it('enqueues the department and names no agent', async () => {
      const res = await post(app, '/twilio/voice/handoff', {
        CallSid: 'CA_escalated',
        HandoffData: JSON.stringify({
          reason: 'ESCALATED',
          uccCallId: 'call_x',
          departmentId: 'dept-admissions',
        }),
      });

      const xml = res.body;
      expect(xml).toContain('<Enqueue');
      expect(xml).toContain('dept-admissions');
      // TaskRouter picks the worker; UCC must not name one.
      expect(xml).not.toMatch(/agent-[a-z]+/);
    });
  });

  it('says goodbye and hangs up when the AI resolved without escalating', async () => {
    const res = await post(app, '/twilio/voice/handoff', {
      CallSid: 'CA_resolved',
      HandoffData: JSON.stringify({ reason: 'RESOLVED', uccCallId: 'call_y' }),
    });

    expect(res.body).toContain('<Hangup');
    expect(res.body).not.toContain('<Enqueue');
  });

  it('ends the UccCall when Twilio reports the call completed', async () => {
    await post(app, '/twilio/voice/inbound', {
      CallSid: 'CA_ending',
      From: PHONE.student,
      To: '+15550000000',
    });

    const res = await post(app, '/twilio/voice/status', {
      CallSid: 'CA_ending',
      CallStatus: 'completed',
    });
    expect(res.statusCode).toBe(204);

    const call = await h.repos.call.byProviderContactId(h.tenantId, 'CA_ending');
    expect(call!.endedAt).toBeTruthy();
  });
});

describe('voice pipeline selection', () => {
  let h: TestHarness;
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PUBLIC_BASE_URL = BASE;
    delete process.env.TWILIO_SKIP_SIGNATURE_CHECK;
    h = await createHarness();
  });

  async function boot(voice: 'conversationrelay' | 'pipecat', wsUrl?: string) {
    process.env.UCC_VOICE = voice;
    if (wsUrl) process.env.PIPECAT_WS_URL = wsUrl;
    else delete process.env.PIPECAT_WS_URL;
    resetConfig();
    app = await createServer(h);
    await app.ready();
  }

  it('uses ConversationRelay by default', async () => {
    await boot('conversationrelay');
    const res = await post(app, '/twilio/voice/inbound', {
      CallSid: 'CA_cr',
      From: PHONE.student,
      To: '+15550000000',
    });
    expect(res.body).toContain('<ConversationRelay');
    expect(res.body).not.toContain('<Stream');
  });

  it('emits a Media Stream to Pipecat when selected, carrying the case id', async () => {
    await boot('pipecat', 'wss://voice.example.test/ws');
    const res = await post(app, '/twilio/voice/inbound', {
      CallSid: 'CA_pc',
      From: PHONE.student,
      To: '+15550000000',
    });

    const xml = res.body;
    expect(xml).toContain('<Stream');
    expect(xml).toContain('wss://voice.example.test/ws');
    expect(xml).not.toContain('<ConversationRelay');

    // Without the case id the pipeline cannot gate, trace or ticket anything.
    const call = await h.repos.call.byProviderContactId(h.tenantId, 'CA_pc');
    expect(xml).toContain(call!.id);

    // Escalation still returns to the same action URL, so routing is unchanged.
    expect(xml).toContain('/twilio/voice/handoff');
  });

  it('refuses to run Pipecat mode without a websocket URL rather than falling back', async () => {
    await boot('pipecat');
    const res = await post(app, '/twilio/voice/inbound', {
      CallSid: 'CA_pc_misconfigured',
      From: PHONE.student,
      To: '+15550000000',
    });
    // Silently serving the other pipeline would hide the misconfiguration until a demo.
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('CONFIGURATION_ERROR');
  });
});
