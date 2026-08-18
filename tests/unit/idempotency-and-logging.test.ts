import { beforeEach, describe, expect, it } from 'vitest';
import { eventIdempotencyKey, redact, createLogger, setLogSink, maskValue } from '@ucc/shared';
import { createHarness, PHONE, startCall, type TestHarness } from '../helpers.ts';

describe('event idempotency', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it('produces a stable key for the same occurrence', () => {
    const a = eventIdempotencyKey('call_1', 'CALL_STARTED', 'provider-evt-1');
    const b = eventIdempotencyKey('call_1', 'CALL_STARTED', 'provider-evt-1');
    expect(a).toBe(b);
  });

  it('produces different keys for different occurrences', () => {
    expect(eventIdempotencyKey('call_1', 'AI_RESPONSE', 'a')).not.toBe(
      eventIdempotencyKey('call_1', 'AI_RESPONSE', 'b'),
    );
    expect(eventIdempotencyKey('call_1', 'CALL_STARTED', 'x')).not.toBe(
      eventIdempotencyKey('call_2', 'CALL_STARTED', 'x'),
    );
  });

  it('discards a duplicate provider event delivery', async () => {
    const started = await startCall(h, PHONE.prospect, 'dup-contact');

    const first = await h.events.emit({
      tenantId: h.tenantId,
      uccCallId: started.call.id,
      type: 'AGENT_CONNECTED',
      actor: 'PROVIDER',
      traceId: 't',
      discriminator: 'provider-evt-77',
    });
    const second = await h.events.emit({
      tenantId: h.tenantId,
      uccCallId: started.call.id,
      type: 'AGENT_CONNECTED',
      actor: 'PROVIDER',
      traceId: 't',
      discriminator: 'provider-evt-77',
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const timeline = await h.events.timelineForCall(h.tenantId, started.call.id);
    expect(timeline.filter((e) => e.type === 'AGENT_CONNECTED')).toHaveLength(1);
  });

  it('does not create a second call or ticket for a redelivered contact', async () => {
    const first = await startCall(h, PHONE.prospect, 'same-contact-id');
    const second = await startCall(h, PHONE.prospect, 'same-contact-id');

    expect(second.created).toBe(false);
    expect(second.call.id).toBe(first.call.id);
    expect(second.ticket.id).toBe(first.ticket.id);

    const calls = await h.calls.list(h.tenantId);
    const tickets = await h.tickets.list(h.tenantId);
    expect(calls.filter((c) => c.providerContactId === 'same-contact-id')).toHaveLength(1);
    expect(tickets.filter((t) => t.uccCallId === first.call.id)).toHaveLength(1);
  });

  it('does not duplicate the case-created timeline entry on redelivery', async () => {
    await startCall(h, PHONE.prospect, 'contact-x');
    await startCall(h, PHONE.prospect, 'contact-x');
    const call = (await h.calls.list(h.tenantId))[0]!;
    const timeline = await h.events.timelineForCall(h.tenantId, call.id);
    expect(timeline.filter((e) => e.type === 'CASE_CREATED')).toHaveLength(1);
    expect(timeline.filter((e) => e.type === 'CALL_STARTED')).toHaveLength(1);
  });

  it('does not assign an agent twice for a repeated assignment event', async () => {
    const started = await startCall(h, PHONE.applicantTwoApps, 'assign-contact');
    await h.routing.escalate({
      tenantId: h.tenantId,
      uccCallId: started.call.id,
      uccTicketId: started.ticket.id,
      category: 'ADMISSIONS_SUPPORT',
      reason: 'test',
      traceId: 't',
    });

    const timeline = await h.events.timelineForCall(h.tenantId, started.call.id);
    expect(timeline.filter((e) => e.type === 'AGENT_ASSIGNED')).toHaveLength(1);
  });
});

describe('log redaction', () => {
  it('removes secret-shaped keys at any depth', () => {
    const out = redact({
      otp: '123456',
      nested: { password: 'hunter2', awsSecretAccessKey: 'AKIA', safe: 'keep-me' },
    }) as any;

    expect(out.otp).toBe('[REDACTED]');
    expect(out.nested.password).toBe('[REDACTED]');
    expect(out.nested.awsSecretAccessKey).toBe('[REDACTED]');
    expect(out.nested.safe).toBe('keep-me');
  });

  it('masks phone numbers and email addresses rather than dropping them', () => {
    const out = redact({ phone: '+919812340002', email: 'rohan.mehta@example.com' }) as any;
    expect(out.phone).not.toBe('+919812340002');
    expect(out.phone).toContain('0002');
    expect(out.email).toContain('@example.com');
    expect(out.email).not.toContain('rohan.mehta');
  });

  it('scrubs a bare passcode that reaches a free-text field', () => {
    const out = redact({ note: 'caller read out 123456 on the line' }) as any;
    expect(out.note).not.toContain('123456');
  });

  it('preserves years so logs stay readable', () => {
    const out = redact({ note: 'Autumn 2026 intake' }) as any;
    expect(out.note).toContain('2026');
  });

  it('never emits a passcode through the logger', () => {
    const records: Record<string, unknown>[] = [];
    setLogSink((r) => records.push(r));
    const log = createLogger({ service: 'test' });
    log.error('verification attempt', { otp: '123456', code: '123456', callerPhone: '+919812340002' });
    setLogSink(null);

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('123456');
  });

  it('masks values predictably', () => {
    expect(maskValue('+919812340002')).toContain('0002');
    expect(maskValue('a@b.com')).toBe('a*@b.com');
  });
});
