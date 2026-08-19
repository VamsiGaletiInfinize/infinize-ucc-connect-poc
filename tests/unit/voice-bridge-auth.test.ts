import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resetConfig } from '@ucc/config';
import { createHarness, PHONE, startCall, type TestHarness } from '../helpers.ts';
import { createServer } from '../../apps/ucc-api/src/server.ts';

/**
 * The voice bridge executes privileged tools for an out-of-process model.
 *
 * Constitution Principle X: moving the model out of the UCC process must not move the
 * security boundary with it. Two credentials are required, and the second one is the point
 * — a service credential alone authenticates the *service* but not the *session*, so any
 * holder could read any case by guessing a call id.
 *
 * These tests are deliberately written from the attacker's side: what does someone who has
 * *part* of what they need get?
 */

const SERVICE_TOKEN = 'voice-service-token-for-tests';

describe('voice bridge authentication', () => {
  let h: TestHarness;
  let app: FastifyInstance;
  let callId: string;
  let sessionToken: string;

  beforeEach(async () => {
    process.env.UCC_VOICE_SERVICE_TOKEN = SERVICE_TOKEN;
    resetConfig();

    h = await createHarness();
    app = await createServer(h);
    await app.ready();

    const started = await startCall(h, PHONE.applicantTwoApps);
    callId = started.call.id;
    sessionToken = (await h.sessionTokens.issue({ tenantId: h.tenantId, uccCallId: callId })).token;
  });

  afterEach(() => {
    delete process.env.UCC_VOICE_SERVICE_TOKEN;
    resetConfig();
  });

  const tool = (headers: Record<string, string>, id = callId) =>
    app.inject({
      method: 'POST',
      url: `/api/calls/${id}/tool`,
      payload: { name: 'get_caller_profile', input: {} },
      headers: { 'content-type': 'application/json', ...headers },
    });

  const svc = { authorization: `Bearer ${SERVICE_TOKEN}` };

  // --- the catalogue -------------------------------------------------------

  it('refuses the tool catalogue without a service credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/tools' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('search_public_knowledge');
  });

  it('serves the tool catalogue to the voice service', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/tools', headers: svc });
    expect(res.statusCode).toBe(200);
    expect(res.json().tools.length).toBeGreaterThan(0);
  });

  // --- tool execution ------------------------------------------------------

  it('refuses tool execution with no credentials at all', async () => {
    const res = await tool({});
    expect(res.statusCode).toBe(401);
  });

  it('refuses tool execution with a wrong service credential', async () => {
    const res = await tool({ authorization: 'Bearer not-the-token' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a service credential of the right length but wrong value', async () => {
    const wrong = 'x'.repeat(SERVICE_TOKEN.length);
    const res = await tool({ authorization: `Bearer ${wrong}` });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a valid service credential with NO session token', async () => {
    // This is the case a shared secret alone would have allowed.
    const res = await tool(svc);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a valid service credential with a made-up session token', async () => {
    const res = await tool({ ...svc, 'x-ucc-session-token': 'invented' });
    expect(res.statusCode).toBe(403);
  });

  it('accepts both credentials together', async () => {
    const res = await tool({ ...svc, 'x-ucc-session-token': sessionToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  // --- the property this design exists for ---------------------------------

  it('refuses a genuine token used against a DIFFERENT case', async () => {
    const other = await startCall(h, PHONE.applicantPendingDocs, 'contact-other-case');

    const res = await tool({ ...svc, 'x-ucc-session-token': sessionToken }, other.call.id);

    expect(res.statusCode).toBe(403);
    // And nothing about the other case leaked in the refusal.
    expect(res.body).not.toContain(other.call.id);
  });

  it('refuses a token after its call has ended', async () => {
    await h.sessionTokens.revokeForCall(h.tenantId, callId);

    const res = await tool({ ...svc, 'x-ucc-session-token': sessionToken });
    expect(res.statusCode).toBe(403);
  });

  it('never echoes either credential back in a response', async () => {
    const res = await tool({ ...svc, 'x-ucc-session-token': sessionToken });
    expect(res.body).not.toContain(SERVICE_TOKEN);
    expect(res.body).not.toContain(sessionToken);
  });

  it('refuses to serve the bridge at all when no service credential is configured', async () => {
    delete process.env.UCC_VOICE_SERVICE_TOKEN;
    resetConfig();
    const unconfigured = await createServer(await createHarness());
    await unconfigured.ready();

    const res = await unconfigured.inject({ method: 'GET', url: '/api/ai/tools' });

    // Refusing loudly beats quietly serving an open privileged channel.
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('search_public_knowledge');
  });
});
