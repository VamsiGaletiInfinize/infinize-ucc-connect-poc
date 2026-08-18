import { beforeEach, describe, expect, it } from 'vitest';
import { setLogSink } from '@ucc/shared';
import { ToolExecutor } from '@ucc/services/ai';
import { createHarness, PHONE, startCall, verifyCall, type TestHarness } from '../helpers.ts';

/**
 * Security suite.
 *
 * These tests attack the system the way a real caller or a manipulated model would, and
 * assert that the SERVER refuses. Nothing here relies on the system prompt.
 */
describe('security boundary', () => {
  let h: TestHarness;
  let tools: ToolExecutor;

  beforeEach(async () => {
    h = await createHarness();
    tools = new ToolExecutor({
      repos: h.repos,
      knowledge: h.knowledge,
      identity: h.identity,
      verification: h.verification,
      applications: h.applications,
      routing: h.routing,
      events: h.events,
    });
  });

  async function ctxFor(phone: string, opts: { verify?: boolean } = {}) {
    const started = await startCall(h, phone, `sec-${Math.random()}`);
    if (opts.verify && started.call.callerRefId) {
      await verifyCall(h, started.call.id, started.ticket.id, started.call.callerRefId);
    }
    const call = await h.calls.get(h.tenantId, started.call.id);
    return h.identity.buildSecurityContext(call, started.ticket.id);
  }

  it('denies the application status tool when the caller is not verified', async () => {
    const ctx = await ctxFor(PHONE.applicantTwoApps);
    const result = await tools.execute('get_application_status', {}, ctx);

    expect(result.ok).toBe(false);
    expect((result.data as any).error).toBe('VERIFICATION_REQUIRED');
    // Crucially, no protected field leaked into the tool result the model will read.
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain('UNDER_REVIEW');
    expect(serialized).not.toContain('M.Tech');
    expect(serialized).not.toContain('ADMITTED');
  });

  it('denies the application list tool when the caller is not verified', async () => {
    const ctx = await ctxFor(PHONE.applicantTwoApps);
    const result = await tools.execute('get_applications', {}, ctx);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('APP-2026-001');
  });

  it('reports verification honestly even if the conversation claims otherwise', async () => {
    // The model cannot set this: `verified` is read from persisted state each turn.
    const ctx = await ctxFor(PHONE.applicantTwoApps);
    const profile = await tools.execute('get_caller_profile', {}, ctx);
    expect((profile.data as any).verified).toBe(false);
  });

  it("denies a verified caller access to another caller's application by id", async () => {
    const ctx = await ctxFor(PHONE.student, { verify: true });
    // Priya is verified, but APP-2026-001 belongs to Rohan.
    const result = await tools.execute(
      'get_application_status',
      { application_id: 'APP-2026-001' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('UNDER_REVIEW');
  });

  it('denies cross-tenant record access even with a valid application id', async () => {
    const ctx = await ctxFor(PHONE.applicantTwoApps, { verify: true });
    const result = await tools.execute(
      'get_application_status',
      { application_id: 'APP-NG-9001' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('M.Tech Mechanical');
  });

  it('cannot read another tenant record through the repository at all', async () => {
    // Structural isolation: the key does not exist under the wrong tenant.
    const foreign = await h.repos.application.byApplicationId(h.tenantId, 'APP-NG-9001');
    expect(foreign).toBeNull();

    const foreignCaller = await h.repos.caller.byPhone(h.tenantId, '+919812349999');
    expect(foreignCaller).toBeNull();
  });

  it('does not disclose data after an exhausted verification attempt sequence', async () => {
    const started = await startCall(h, PHONE.applicantTwoApps, 'sec-lock');
    const challenge = await h.verification.requestVerification({
      tenantId: h.tenantId,
      uccCallId: started.call.id,
      uccTicketId: started.ticket.id,
      callerId: 'caller-rohan',
      destination: PHONE.applicantTwoApps,
      traceId: 't',
    });

    for (const bad of ['111111', '222222', '333333']) {
      await h.verification.verify({
        tenantId: h.tenantId,
        uccCallId: started.call.id,
        uccTicketId: started.ticket.id,
        sessionId: challenge.sessionId,
        code: bad,
        traceId: 't',
      });
    }

    const call = await h.calls.get(h.tenantId, started.call.id);
    const ctx = await h.identity.buildSecurityContext(call, started.ticket.id);
    const result = await tools.execute('get_application_status', {}, ctx);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('UNDER_REVIEW');
  });

  it('rejects a verification session lifted from another call', async () => {
    const first = await startCall(h, PHONE.applicantTwoApps, 'sec-a');
    const challenge = await h.verification.requestVerification({
      tenantId: h.tenantId,
      uccCallId: first.call.id,
      uccTicketId: first.ticket.id,
      callerId: 'caller-rohan',
      destination: PHONE.applicantTwoApps,
      traceId: 't',
    });

    const second = await startCall(h, PHONE.applicantTwoApps, 'sec-b');
    await expect(
      h.verification.verify({
        tenantId: h.tenantId,
        uccCallId: second.call.id,
        uccTicketId: second.ticket.id,
        sessionId: challenge.sessionId,
        code: '123456',
        traceId: 't',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('does not carry verification from one call to the next', async () => {
    const first = await startCall(h, PHONE.applicantTwoApps, 'sec-c');
    await verifyCall(h, first.call.id, first.ticket.id, 'caller-rohan');
    expect(await h.verification.isCallVerified(h.tenantId, first.call.id)).toBe(true);

    // Same caller, new contact: must verify again.
    const second = await startCall(h, PHONE.applicantTwoApps, 'sec-d');
    expect(await h.verification.isCallVerified(h.tenantId, second.call.id)).toBe(false);

    const call = await h.calls.get(h.tenantId, second.call.id);
    const ctx = await h.identity.buildSecurityContext(call, second.ticket.id);
    expect(ctx.verified).toBe(false);
  });

  it('exposes no API surface that sets ticket status directly', async () => {
    // FR-003: TicketService.update deliberately omits `status` from its patch type.
    const started = await startCall(h, PHONE.prospect, 'sec-e');
    const patched = await h.tickets.update(h.tenantId, started.ticket.id, {
      // @ts-expect-error — status is intentionally not assignable through update()
      status: 'CLOSED',
      priority: 'HIGH',
    });

    expect(patched.status).toBe('AI_HANDLING');
    expect(patched.priority).toBe('HIGH');
  });

  it('rejects an invalid ticket transition attempted through the service', async () => {
    const started = await startCall(h, PHONE.prospect, 'sec-f');
    await expect(
      h.tickets.transition(h.tenantId, started.ticket.id, 'RESOLVED', { actor: 'SYSTEM' }),
    ).rejects.toMatchObject({ code: 'INVALID_TICKET_TRANSITION' });
  });

  it('never writes a passcode, secret or credential to the logs', async () => {
    const records: unknown[] = [];
    setLogSink((r) => records.push(r));
    process.env.LOG_LEVEL = 'debug';

    const started = await startCall(h, PHONE.applicantTwoApps, 'sec-log');
    const challenge = await h.verification.requestVerification({
      tenantId: h.tenantId,
      uccCallId: started.call.id,
      uccTicketId: started.ticket.id,
      callerId: 'caller-rohan',
      destination: PHONE.applicantTwoApps,
      traceId: 't',
    });
    await h.verification.verify({
      tenantId: h.tenantId,
      uccCallId: started.call.id,
      uccTicketId: started.ticket.id,
      sessionId: challenge.sessionId,
      code: '123456',
      traceId: 't',
    });

    setLogSink(null);
    process.env.LOG_LEVEL = 'error';

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toMatch(/ASIA[A-Z0-9]{10,}/);
    expect(serialized).not.toContain('aws_secret_access_key');
  });

  it('keeps the passcode out of every persisted record', async () => {
    const started = await startCall(h, PHONE.applicantTwoApps, 'sec-store');
    await verifyCall(h, started.call.id, started.ticket.id, 'caller-rohan');

    const everything = JSON.stringify({
      sessions: await h.repos.verification.list(h.tenantId),
      events: await h.events.timelineForCall(h.tenantId, started.call.id),
      tickets: await h.tickets.list(h.tenantId),
      transcript: await h.transcripts.byCall(h.tenantId, started.call.id),
    });

    expect(everything).not.toContain('123456');
  });
});
