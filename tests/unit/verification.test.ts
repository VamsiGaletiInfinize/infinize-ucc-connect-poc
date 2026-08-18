import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, PHONE, startCall, type TestHarness } from '../helpers.ts';

describe('identity verification', () => {
  let h: TestHarness;
  let callId: string;
  let ticketId: string;

  beforeEach(async () => {
    h = await createHarness();
    const started = await startCall(h, PHONE.applicantTwoApps, `vrf-${Date.now()}-${Math.random()}`);
    callId = started.call.id;
    ticketId = started.ticket.id;
  });

  const challenge = () =>
    h.verification.requestVerification({
      tenantId: h.tenantId,
      uccCallId: callId,
      uccTicketId: ticketId,
      callerId: 'caller-rohan',
      destination: PHONE.applicantTwoApps,
      traceId: 't',
    });

  const submit = (sessionId: string, code: string) =>
    h.verification.verify({
      tenantId: h.tenantId,
      uccCallId: callId,
      uccTicketId: ticketId,
      sessionId,
      code,
      traceId: 't',
    });

  it('accepts the correct passcode and marks the call verified', async () => {
    const c = await challenge();
    const result = await submit(c.sessionId, '123456');
    expect(result.verified).toBe(true);
    expect(await h.verification.isCallVerified(h.tenantId, callId)).toBe(true);
  });

  it('rejects an incorrect passcode and leaves the call unverified', async () => {
    const c = await challenge();
    const result = await submit(c.sessionId, '000000');
    expect(result.verified).toBe(false);
    expect(await h.verification.isCallVerified(h.tenantId, callId)).toBe(false);
  });

  it('locks the session after the attempt limit is exhausted', async () => {
    const c = await challenge();
    await submit(c.sessionId, '111111');
    await submit(c.sessionId, '222222');
    await submit(c.sessionId, '333333');

    // Even the CORRECT code must now fail — the session is spent.
    const afterLock = await submit(c.sessionId, '123456');
    expect(afterLock.verified).toBe(false);
    expect(afterLock.reason).toMatch(/too many/i);
    expect(await h.verification.isCallVerified(h.tenantId, callId)).toBe(false);
  });

  it('rejects an expired passcode', async () => {
    const c = await challenge();
    // Advance past the 5 minute TTL.
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(c.expiresAt) + 1000);
    const result = await submit(c.sessionId, '123456');
    vi.restoreAllMocks();

    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/expired/i);
    expect(await h.verification.isCallVerified(h.tenantId, callId)).toBe(false);
  });

  it('refuses to verify a session belonging to a different call', async () => {
    const c = await challenge();
    const other = await startCall(h, PHONE.student, `other-${Date.now()}`);

    await expect(
      h.verification.verify({
        tenantId: h.tenantId,
        uccCallId: other.call.id,
        uccTicketId: other.ticket.id,
        sessionId: c.sessionId,
        code: '123456',
        traceId: 't',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });

    expect(await h.verification.isCallVerified(h.tenantId, other.call.id)).toBe(false);
  });

  it('never persists the passcode in plaintext', async () => {
    const c = await challenge();
    const session = await h.repos.verification.get(h.tenantId, c.sessionId);
    expect(session).toBeTruthy();
    expect(JSON.stringify(session)).not.toContain('123456');
    expect(session!.otpHash).not.toBe('123456');
  });

  it('does not place the passcode on the event timeline', async () => {
    const c = await challenge();
    await submit(c.sessionId, '123456');
    const timeline = await h.events.timelineForCall(h.tenantId, callId);
    expect(JSON.stringify(timeline)).not.toContain('123456');
    expect(timeline.map((e) => e.type)).toContain('OTP_SENT');
    expect(timeline.map((e) => e.type)).toContain('IDENTITY_VERIFIED');
  });

  it('masks the delivery destination rather than echoing the full number', async () => {
    const c = await challenge();
    expect(c.maskedDestination).not.toBe(PHONE.applicantTwoApps);
    expect(c.maskedDestination).toContain('*');
    expect(c.maskedDestination).toContain('0002');
  });
});
