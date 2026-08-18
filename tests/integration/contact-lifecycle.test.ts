import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, PHONE, startCall, verifyCall, type TestHarness } from '../helpers.ts';
import { summariseCallLoad } from '../../apps/ucc-api/src/routes/operations.ts';

describe('contact lifecycle', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it('opens a UccCall AND a UccTicket for every inbound contact', async () => {
    const { call, ticket, created } = await startCall(h, PHONE.prospect, 'c1');

    expect(created).toBe(true);
    expect(call.direction).toBe('INBOUND');
    expect(call.status).toBe('AI_HANDLING');
    expect(ticket.uccCallId).toBe(call.id);
    expect(ticket.status).toBe('AI_HANDLING');
    expect(ticket.ticketNumber).toMatch(/^UCC-\d+$/);
  });

  it('opens a case for outbound contacts too', async () => {
    const { call, ticket } = await h.calls.startOutbound({
      tenantId: h.tenantId,
      callerId: 'caller-imran',
      destinationPhoneNumber: PHONE.applicantPendingDocs,
      category: 'DEADLINE_REMINDER',
    });

    expect(call.direction).toBe('OUTBOUND');
    expect(ticket).toBeTruthy();
    expect(ticket.uccCallId).toBe(call.id);
  });

  it('resolves the caller identity from the calling number', async () => {
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'c2');
    expect(call.callerType).toBe('APPLICANT');
    expect(call.callerRefId).toBe('caller-rohan');
    expect(ticket.callerType).toBe('APPLICANT');
  });

  it('marks an unrecognised number as UNKNOWN without failing the call', async () => {
    const { call, ticket } = await startCall(h, PHONE.unknown, 'c3');
    expect(call.callerType).toBe('UNKNOWN');
    expect(call.callerRefId).toBeUndefined();
    expect(ticket).toBeTruthy();
  });

  it('correlates a provider contact id back to the UCC case in one lookup', async () => {
    const { call, ticket } = await startCall(h, PHONE.student, 'connect-contact-abc');

    const found = await h.repos.call.byProviderContactId(h.tenantId, 'connect-contact-abc');
    expect(found?.id).toBe(call.id);

    const foundTicket = await h.repos.ticket.byCallId(h.tenantId, found!.id);
    expect(foundTicket?.id).toBe(ticket.id);
    expect(foundTicket?.traceId).toBe(call.traceId);
  });

  it('records the full lifecycle on the timeline and computes duration at end', async () => {
    const { call, ticket } = await startCall(h, PHONE.prospect, 'c4');
    const ended = await h.calls.endCall({ tenantId: h.tenantId, callId: call.id });

    expect(ended.endedAt).toBeTruthy();
    expect(ended.duration).toBeGreaterThanOrEqual(0);
    expect(ended.status).toBe('COMPLETED');

    const timeline = await h.events.timelineForCall(h.tenantId, call.id);
    const types = timeline.map((e) => e.type);
    expect(types).toContain('CALL_STARTED');
    expect(types).toContain('CASE_CREATED');
    expect(types).toContain('CALL_ENDED');
    expect(timeline.every((e) => e.traceId === call.traceId)).toBe(true);
    expect(ticket).toBeTruthy();
  });

  it('is idempotent when a call end is redelivered', async () => {
    const { call } = await startCall(h, PHONE.prospect, 'c5');
    const first = await h.calls.endCall({ tenantId: h.tenantId, callId: call.id });
    const second = await h.calls.endCall({ tenantId: h.tenantId, callId: call.id });

    expect(second.endedAt).toBe(first.endedAt);
    const timeline = await h.events.timelineForCall(h.tenantId, call.id);
    expect(timeline.filter((e) => e.type === 'CALL_ENDED')).toHaveLength(1);
  });
});

describe('escalation, routing and agent handling', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it('routes an admissions escalation to the Admissions queue and assigns an agent', async () => {
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'esc1');

    const result = await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'Caller asked for an admissions officer',
      traceId: call.traceId,
    });

    expect(result.department.code).toBe('ADMISSIONS');
    expect(result.agent).toBeTruthy();
    expect(result.ticket.status).toBe('AGENT_ASSIGNED');
    expect(result.ticket.assignedAgentId).toBe(result.agent!.id);

    // Amazon Connect was asked to perform the queue transfer — UCC did not route itself.
    expect(h.simulated.transfers).toHaveLength(1);
    expect(h.simulated.transfers[0]!.queueId).toBe('queue-admissions');

    const timeline = await h.events.timelineForTicket(h.tenantId, ticket.id);
    const types = timeline.map((e) => e.type);
    expect(types).toContain('ESCALATION_REQUESTED');
    expect(types).toContain('ROUTING_STARTED');
    expect(types).toContain('QUEUE_ENTERED');
    expect(types).toContain('AGENT_ASSIGNED');
  });

  it('routes a fees enquiry to Financial Aid', async () => {
    const { call, ticket } = await startCall(h, PHONE.student, 'esc2');
    const result = await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'FEES_AND_PAYMENTS',
      reason: 'fee query',
      traceId: call.traceId,
    });
    expect(result.department.code).toBe('FINANCIAL_AID');
    expect(result.agent?.id).toBe('agent-michael');
  });

  it('recommends a callback when every agent for the department is unavailable', async () => {
    for (const agent of await h.repos.agent.list(h.tenantId)) {
      await h.agents.setStatus(h.tenantId, agent.id, 'OFFLINE');
    }

    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'esc3');
    const result = await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'needs a person',
      traceId: call.traceId,
    });

    expect(result.agent).toBeNull();
    expect(result.callbackRecommended).toBe(true);
    expect(result.ticket.status).toBe('QUEUED_FOR_AGENT');
  });

  it('carries a case through accept, note, resolve and close', async () => {
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'agent1');
    const escalation = await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'human requested',
      traceId: call.traceId,
    });
    const agentId = escalation.agent!.id;

    const accepted = await h.agents.acceptTicket({ tenantId: h.tenantId, ticketId: ticket.id, agentId });
    expect(accepted.status).toBe('AGENT_HANDLING');

    const noted = await h.agents.addNote({
      tenantId: h.tenantId,
      ticketId: ticket.id,
      agentId,
      body: 'Confirmed committee meets 22 August.',
    });
    expect(noted.notes).toHaveLength(1);
    expect(noted.notes[0]!.authorName).toBe('Aditya Sharma');

    const resolved = await h.agents.resolveTicket({
      tenantId: h.tenantId,
      ticketId: ticket.id,
      agentId,
      resolution: 'Explained review timeline to the applicant.',
    });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedAt).toBeTruthy();

    const closed = await h.agents.closeTicket({ tenantId: h.tenantId, ticketId: ticket.id, agentId });
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).toBeTruthy();

    // The agent is released back to the floor.
    const agent = await h.repos.agent.get(h.tenantId, agentId);
    expect(agent!.currentCallId).toBeUndefined();
  });

  it('refuses to let a different agent resolve an assigned case', async () => {
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'agent2');
    const escalation = await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'r',
      traceId: call.traceId,
    });
    await h.agents.acceptTicket({
      tenantId: h.tenantId,
      ticketId: ticket.id,
      agentId: escalation.agent!.id,
    });

    await expect(
      h.agents.resolveTicket({
        tenantId: h.tenantId,
        ticketId: ticket.id,
        agentId: 'agent-kavya',
        resolution: 'not mine to resolve',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
});

describe('callback lifecycle', () => {
  it('queues a callback and completes it with timeline entries', async () => {
    const h = await createHarness();
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'cb1');

    const callback = await h.routing.requestCallback({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      callerId: 'caller-rohan',
      phone: PHONE.applicantTwoApps,
      departmentId: 'dept-admissions',
      traceId: call.traceId,
    });

    expect(callback.status).toBe('QUEUED');
    expect(h.simulated.callbacks).toHaveLength(1);

    const completed = await h.routing.completeCallback({
      tenantId: h.tenantId,
      callbackId: callback.id,
      agentId: 'agent-aditya',
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.agentId).toBe('agent-aditya');

    const types = (await h.events.timelineForTicket(h.tenantId, ticket.id)).map((e) => e.type);
    expect(types).toContain('CALLBACK_REQUESTED');
    expect(types).toContain('CALLBACK_COMPLETED');
  });
});

describe('outbound campaign', () => {
  it('creates a case per outbound contact from the system of record', async () => {
    const h = await createHarness();
    const campaign = await h.outbound.createDeadlineReminderCampaign(h.tenantId);

    // Targets are derived from applications with pending documents, not hand-written.
    expect(campaign.targetCallerIds.length).toBeGreaterThan(0);
    expect(campaign.targetCallerIds).toContain('caller-imran');

    const run = await h.outbound.runCampaign(h.tenantId, campaign.id);
    expect(run.campaign.status).toBe('COMPLETED');
    expect(run.contacts.length).toBe(campaign.targetCallerIds.length);

    for (const contact of run.contacts) {
      expect(contact.call.direction).toBe('OUTBOUND');
      expect(contact.ticket.uccCallId).toBe(contact.call.id);
      expect(contact.ticket.priority).toBe('HIGH');
    }
  });
});

describe('application service', () => {
  it('requires verification before returning anything', async () => {
    const h = await createHarness();
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'app1');
    const ctx = await h.identity.buildSecurityContext(call, ticket.id);

    await expect(h.applications.listForContact(ctx)).rejects.toMatchObject({
      code: 'VERIFICATION_REQUIRED',
    });
    await expect(h.applications.getStatusForContact(ctx)).rejects.toMatchObject({
      code: 'VERIFICATION_REQUIRED',
    });
  });

  it('raises AMBIGUOUS_RESOURCE rather than picking one of two applications', async () => {
    const h = await createHarness();
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'app2');
    await verifyCall(h, call.id, ticket.id, 'caller-rohan');
    const ctx = await h.identity.buildSecurityContext(
      await h.calls.get(h.tenantId, call.id),
      ticket.id,
    );

    const list = await h.applications.listForContact(ctx);
    expect(list).toHaveLength(2);

    await expect(h.applications.getStatusForContact(ctx)).rejects.toMatchObject({
      code: 'AMBIGUOUS_RESOURCE',
    });
  });

  it('returns the requested application once disambiguated', async () => {
    const h = await createHarness();
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'app3');
    await verifyCall(h, call.id, ticket.id, 'caller-rohan');
    const ctx = await h.identity.buildSecurityContext(
      await h.calls.get(h.tenantId, call.id),
      ticket.id,
    );

    const view = await h.applications.getStatusForContact(ctx, 'APP-2026-001');
    expect(view.applicationId).toBe('APP-2026-001');
    expect(view.status).toBe('UNDER_REVIEW');
    expect(view.program).toBe('M.Tech Computer Science');

    const mba = await h.applications.getStatusForContact(ctx, 'APP-2026-002');
    expect(mba.status).toBe('ADMITTED');
  });

  it('escalates rather than fabricating when the university API is down', async () => {
    const h = await createHarness();
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'app4');
    await verifyCall(h, call.id, ticket.id, 'caller-rohan');
    const ctx = await h.identity.buildSecurityContext(
      await h.calls.get(h.tenantId, call.id),
      ticket.id,
    );

    h.applications.setFailureMode(true);
    await expect(h.applications.getStatusForContact(ctx, 'APP-2026-001')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });

  it('never exposes internal notes in the caller-facing view', async () => {
    const h = await createHarness();
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'app5');
    await verifyCall(h, call.id, ticket.id, 'caller-rohan');
    const ctx = await h.identity.buildSecurityContext(
      await h.calls.get(h.tenantId, call.id),
      ticket.id,
    );

    const view = await h.applications.getStatusForContact(ctx, 'APP-2026-001');
    expect(JSON.stringify(view)).not.toContain('Shortlisted for departmental review');
    expect((view as unknown as Record<string, unknown>).notes).toBeUndefined();
  });
});

describe('supervisor floor metrics', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  /**
   * Regression: a call assigned to an agent but not yet accepted was counted as "waiting in
   * queue" on the supervisor dashboard, while the per-queue table showed zero waiting. The
   * two panels disagreed on screen because they measured different things.
   */
  it('counts an assigned-but-unaccepted call as ringing, not waiting', async () => {
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'floor1');

    const result = await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'wants an admissions officer',
      traceId: call.traceId,
    });
    expect(result.ticket.status).toBe('AGENT_ASSIGNED');

    const assigned = await h.calls.get(h.tenantId, call.id);
    // The call legitimately remains QUEUED until the agent accepts...
    expect(assigned.status).toBe('QUEUED');
    expect(assigned.agentId).toBeTruthy();

    // ...but it is ringing at an agent, not waiting for one.
    const load = summariseCallLoad([assigned]);
    expect(load.waitingCalls).toBe(0);
    expect(load.ringingCalls).toBe(1);

    // And it agrees with the per-queue table, which counts QUEUED_FOR_AGENT tickets.
    const queues = await h.routing.queueSnapshot(h.tenantId);
    const admissions = queues.find((q) => q.code === 'ADMISSIONS')!;
    expect(admissions.waiting).toBe(0);
    expect(load.waitingCalls).toBe(admissions.waiting);

    // After acceptance the call moves to the agent bucket.
    await h.agents.acceptTicket({
      tenantId: h.tenantId,
      ticketId: ticket.id,
      agentId: result.agent!.id,
    });
    const accepted = await h.calls.get(h.tenantId, call.id);
    const afterAccept = summariseCallLoad([accepted]);
    expect(afterAccept.agentCalls).toBe(1);
    expect(afterAccept.ringingCalls).toBe(0);
    expect(afterAccept.waitingCalls).toBe(0);
  });

  it('counts a call with no agent yet as waiting', async () => {
    for (const agent of await h.repos.agent.list(h.tenantId)) {
      await h.agents.setStatus(h.tenantId, agent.id, 'OFFLINE');
    }
    const { call, ticket } = await startCall(h, PHONE.applicantTwoApps, 'floor2');
    await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: call.id,
      uccTicketId: ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'no agents free',
      traceId: call.traceId,
    });

    const queued = await h.calls.get(h.tenantId, call.id);
    const load = summariseCallLoad([queued]);
    expect(load.waitingCalls).toBe(1);
    expect(load.ringingCalls).toBe(0);
  });
});
