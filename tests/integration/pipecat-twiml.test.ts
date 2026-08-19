import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import twilio from 'twilio';
import type { FastifyInstance } from 'fastify';
import { resetConfig } from '@ucc/config';
import { createHarness, PHONE, type TestHarness } from '../helpers.ts';
import { createServer } from '../../apps/ucc-api/src/server.ts';

/**
 * TwiML for the Pipecat voice leg.
 *
 * Three properties are pinned here because each one has a real failure behind it:
 *
 *   1. The greeting is spoken BEFORE <Connect>. There is roughly a second between Twilio
 *      answering and the media stream carrying audio. Greet after it and the caller says
 *      "hello?" into a stream nobody is listening to, and loses their opening utterance.
 *   2. All three stream parameters are present. The pipeline refuses a session without the
 *      case id or the session token, so a missing parameter is a dead call, not a
 *      degraded one.
 *   3. Signature verification still applies. This route now mints a credential, which
 *      makes an unsigned request more attractive, not less.
 */

const AUTH_TOKEN = 'test-auth-token';
const BASE = 'https://ucc.example.test';
const WS = 'wss://voice.example.test/ws';

function sign(url: string, params: Record<string, string>): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
}

async function inbound(
  app: FastifyInstance,
  params: Record<string, string>,
  opts: { signed: boolean } = { signed: true },
) {
  const path = '/twilio/voice/inbound';
  return app.inject({
    method: 'POST',
    url: path,
    payload: new URLSearchParams(params).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(opts.signed ? { 'x-twilio-signature': sign(`${BASE}${path}`, params) } : {}),
    },
  });
}

const CALL = { CallSid: 'CA_pipecat_1', From: PHONE.applicantTwoApps, To: '+15550000000' };

describe('Pipecat TwiML', () => {
  let h: TestHarness;
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
    process.env.PUBLIC_BASE_URL = BASE;
    process.env.UCC_VOICE = 'pipecat';
    process.env.PIPECAT_WS_URL = WS;
    delete process.env.TWILIO_SKIP_SIGNATURE_CHECK;
    resetConfig();

    h = await createHarness();
    app = await createServer(h);
    await app.ready();
  });

  afterEach(() => {
    process.env.UCC_VOICE = 'conversationrelay';
    delete process.env.PIPECAT_WS_URL;
    resetConfig();
  });

  it('speaks the greeting before opening the stream, so no opening utterance is lost', async () => {
    const res = await inbound(app, CALL);
    expect(res.statusCode).toBe(200);

    const xml = res.body;
    const sayAt = xml.indexOf('<Say');
    const connectAt = xml.indexOf('<Connect');

    expect(sayAt).toBeGreaterThan(-1);
    expect(connectAt).toBeGreaterThan(-1);
    expect(sayAt).toBeLessThan(connectAt);
    expect(xml).toContain('Thank you for calling Infinize University');
  });

  it('streams to the configured websocket and posts back to the shared handoff URL', async () => {
    const xml = (await inbound(app, CALL)).body;
    expect(xml).toContain(`url="${WS}"`);
    // The same action URL as the ConversationRelay path, so escalation and ticketing
    // behave identically whichever pipeline carried the audio.
    expect(xml).toContain(`action="${BASE}/twilio/voice/handoff"`);
  });

  it('carries the case id, tenant and a session token as stream parameters', async () => {
    const xml = (await inbound(app, CALL)).body;

    expect(xml).toContain('name="uccCallId"');
    expect(xml).toContain('name="tenantId"');
    expect(xml).toContain('name="sessionToken"');

    const call = await h.repos.call.byProviderContactId(h.tenantId, CALL.CallSid);
    expect(call).not.toBeNull();
    expect(xml).toContain(`value="${call!.id}"`);
  });

  it('mints a session token bound to this call, stored only as a hash', async () => {
    const xml = (await inbound(app, CALL)).body;

    const token = /name="sessionToken" value="([^"]+)"/.exec(xml)?.[1];
    expect(token).toBeTruthy();

    const call = await h.repos.call.byProviderContactId(h.tenantId, CALL.CallSid);
    const issued = await h.repos.sessionToken.forCall(h.tenantId, call!.id);

    expect(issued).toHaveLength(1);
    expect(issued[0]!.uccCallId).toBe(call!.id);
    // The plaintext must never be recoverable from storage.
    expect(issued[0]!.tokenHash).not.toBe(token);
    expect(JSON.stringify(issued[0])).not.toContain(token!);
  });

  it('accepts the token it just minted, and refuses it for a different case', async () => {
    const xml = (await inbound(app, CALL)).body;
    const token = /name="sessionToken" value="([^"]+)"/.exec(xml)![1]!;
    const call = await h.repos.call.byProviderContactId(h.tenantId, CALL.CallSid);

    await expect(
      h.sessionTokens.check({ tenantId: h.tenantId, uccCallId: call!.id, token }),
    ).resolves.toEqual({ ok: true });

    // A valid token must not unlock somebody else's case.
    await expect(
      h.sessionTokens.check({ tenantId: h.tenantId, uccCallId: 'call_someone_else', token }),
    ).resolves.toEqual({ ok: false, reason: 'UNKNOWN_TOKEN' });
  });

  it('still rejects an unsigned request, and mints nothing when it does', async () => {
    const res = await inbound(app, { ...CALL, CallSid: 'CA_forged' }, { signed: false });

    expect(res.statusCode).toBe(403);
    const all = await h.repos.call.list(h.tenantId);
    expect(all.find((call) => call.providerContactId === 'CA_forged')).toBeUndefined();
  });

  it('refuses to emit TwiML when the websocket URL is not configured', async () => {
    delete process.env.PIPECAT_WS_URL;
    resetConfig();
    // Routes capture configuration when they are registered, so the server has to be
    // rebuilt for the change to take effect - exactly as a restart would do in operation.
    const restarted = await createServer(await createHarness());
    await restarted.ready();

    const res = await inbound(restarted, { ...CALL, CallSid: 'CA_no_ws' });

    // Refusing loudly beats silently serving the other pipeline: an operator who thinks
    // they are testing Pipecat must not be measuring ConversationRelay.
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('<Stream');
  });
});
