import { beforeEach, describe, expect, it } from 'vitest';
import type { CallSecurityContext } from '@ucc/types';
import { createHarness, PHONE, startCall, verifyCall, type TestHarness } from '../helpers.ts';

/**
 * The authorization gate is the security core of the POC (constitution Principle III).
 * These tests exercise it directly, bypassing the model entirely — because that is exactly
 * the guarantee: the decision does not depend on what the model says.
 */
describe('server-side authorization gate', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  async function contextFor(phone: string, opts: { verify?: boolean } = {}) {
    const started = await startCall(h, phone, `authz-${Math.random()}`);
    if (opts.verify) {
      await verifyCall(h, started.call.id, started.ticket.id, started.call.callerRefId!);
    }
    const call = await h.calls.get(h.tenantId, started.call.id);
    return {
      ctx: await h.identity.buildSecurityContext(call, started.ticket.id),
      started,
    };
  }

  it('denies an unverified caller access to their own application', async () => {
    const { ctx } = await contextFor(PHONE.applicantTwoApps);
    const app = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-001'))!;

    const decision = await h.identity.authorizeApplicationAccess(ctx, app);
    expect(decision.effect).toBe('DENY');
    expect(decision.code).toBe('NOT_VERIFIED');
    expect(decision.requiresVerification).toBe(true);
  });

  it('allows a verified owner access to their own application', async () => {
    const { ctx } = await contextFor(PHONE.applicantTwoApps, { verify: true });
    const app = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-001'))!;

    const decision = await h.identity.authorizeApplicationAccess(ctx, app);
    expect(decision.effect).toBe('ALLOW');
  });

  it("denies a verified caller access to someone else's application", async () => {
    // Priya is verified, but APP-2026-001 belongs to Rohan.
    const { ctx } = await contextFor(PHONE.student, { verify: true });
    const someoneElse = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-001'))!;

    const decision = await h.identity.authorizeApplicationAccess(ctx, someoneElse);
    expect(decision.effect).toBe('DENY');
    expect(decision.code).toBe('NOT_RESOURCE_OWNER');
  });

  it('allows a verified guardian access to their linked student record', async () => {
    // Sunita is PARENT of STU1001 (Rohan).
    const { ctx } = await contextFor(PHONE.parent, { verify: true });
    const childApp = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-001'))!;

    const decision = await h.identity.authorizeApplicationAccess(ctx, childApp);
    expect(decision.effect).toBe('ALLOW');
  });

  it('denies a guardian access to a student they are not linked to', async () => {
    const { ctx } = await contextFor(PHONE.parent, { verify: true });
    const unrelated = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-014'))!;

    const decision = await h.identity.authorizeApplicationAccess(ctx, unrelated);
    expect(decision.effect).toBe('DENY');
    expect(decision.code).toBe('NOT_RESOURCE_OWNER');
  });

  it('denies an unidentified caller outright', async () => {
    const { ctx } = await contextFor(PHONE.unknown);
    const app = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-001'))!;

    const decision = await h.identity.authorizeApplicationAccess(ctx, app);
    expect(decision.effect).toBe('DENY');
    expect(decision.code).toBe('UNKNOWN_CALLER');
  });

  it('denies a cross-tenant record even for a verified caller', async () => {
    const { ctx } = await contextFor(PHONE.applicantTwoApps, { verify: true });
    // Fetch the other tenant's record directly, simulating a leak into the code path.
    const foreign = (await h.repos.application.byApplicationId('northgate-institute', 'APP-NG-9001'))!;
    expect(foreign).toBeTruthy();

    const decision = await h.identity.authorizeApplicationAccess(ctx, foreign);
    expect(decision.effect).toBe('DENY');
    expect(decision.code).toBe('TENANT_MISMATCH');
  });

  it('cannot be fooled by a forged security context claiming verification', async () => {
    // An attacker-controlled context asserting verified:true still fails ownership,
    // because ownership is re-read from the persisted caller record.
    const forged: CallSecurityContext = {
      tenantId: h.tenantId,
      uccCallId: 'call_forged',
      uccTicketId: 'tkt_forged',
      callerId: 'caller-priya',
      callerType: 'STUDENT',
      verified: true,
      traceId: 'forged',
    };
    const rohansApp = (await h.repos.application.byApplicationId(h.tenantId, 'APP-2026-001'))!;

    const decision = await h.identity.authorizeApplicationAccess(forged, rohansApp);
    expect(decision.effect).toBe('DENY');
  });

  it('lists only the student ids a verified caller may access', async () => {
    const unverified = await contextFor(PHONE.applicantTwoApps);
    expect(await h.identity.accessibleStudentIds(unverified.ctx)).toEqual([]);

    const verified = await contextFor(PHONE.applicantTwoApps, { verify: true });
    expect(await h.identity.accessibleStudentIds(verified.ctx)).toEqual(['STU1001']);

    const parent = await contextFor(PHONE.parent, { verify: true });
    expect(await h.identity.accessibleStudentIds(parent.ctx)).toContain('STU1001');
  });
});
