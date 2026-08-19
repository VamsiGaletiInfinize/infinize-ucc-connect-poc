import { describe, expect, it, vi } from 'vitest';
import type { Twilio } from 'twilio';
import { TwilioProvider } from '../../services/telephony/src/twilio-provider.ts';

/**
 * These tests pin the *contract* the adapter must honour, not Twilio's behaviour. A fake
 * client stands in for the SDK so the suite runs offline and in CI without credentials.
 *
 * The properties that matter:
 *   - UCC correlation ids survive onto the provider, or a call cannot be traced back
 *   - in TaskRouter mode, UCC hands over a department and never names an agent
 *   - in UCC mode, no TaskRouter task is created at all
 *   - missing configuration fails loudly rather than half-working
 *   - phone numbers are not written to logs
 */

interface Captured {
  calls: { create: unknown[]; update: unknown[]; endedSid?: string };
  tasks: unknown[];
  recordingsListArgs: unknown[];
}

function fakeTwilio(overrides: { recordings?: unknown[] } = {}) {
  const captured: Captured = { calls: { create: [], update: [] }, tasks: [], recordingsListArgs: [] };

  const client = {
    calls: Object.assign(
      (sid: string) => ({
        update: async (args: unknown) => {
          captured.calls.endedSid = sid;
          captured.calls.update.push(args);
          return {};
        },
      }),
      {
        create: async (args: unknown) => {
          captured.calls.create.push(args);
          return { sid: 'CA_fake_call_sid' };
        },
      },
    ),
    taskrouter: {
      v1: {
        workspaces: (_ws: string) => ({
          tasks: {
            create: async (args: unknown) => {
              captured.tasks.push(args);
              return { sid: 'WT_fake_task_sid' };
            },
          },
        }),
      },
    },
    recordings: {
      list: async (args: unknown) => {
        captured.recordingsListArgs.push(args);
        return overrides.recordings ?? [];
      },
    },
  } as unknown as Twilio;

  return { client, captured };
}

/** TaskRouter-owned routing (useTaskRouter = true). */
const make = (client: Twilio) =>
  new TwilioProvider(
    'AC_test',
    'unused-token',
    '+15550000000',
    'WS_test',
    'WW_test',
    'https://ucc.example.test',
    true,
    client,
  );

/** UCC-owned routing (useTaskRouter = false). */
const makeUccRouted = (client: Twilio) =>
  new TwilioProvider(
    'AC_test',
    'unused-token',
    '+15550000000',
    'WS_test',
    'WW_test',
    'https://ucc.example.test',
    false,
    client,
  );

describe('TwilioProvider', () => {
  it('reports itself as a live provider named TWILIO', () => {
    const { client } = fakeTwilio();
    const p = make(client);
    expect(p.name).toBe('TWILIO');
    expect(p.isLive()).toBe(true);
  });

  it('carries UCC correlation ids onto the outbound answer URL', async () => {
    const { client, captured } = fakeTwilio();
    const p = make(client);

    const result = await p.startOutboundContact({
      destinationPhoneNumber: '+919812340005',
      attributes: { uccCallId: 'call_123', uccTicketId: 'tkt_456', tenantId: 'infinize-university' },
    });

    expect(result.providerContactId).toBe('CA_fake_call_sid');

    const args = captured.calls.create[0] as { url: string; from: string; record: boolean };
    const url = new URL(args.url);
    // Without these the webhook cannot correlate the call back to its case.
    expect(url.searchParams.get('uccCallId')).toBe('call_123');
    expect(url.searchParams.get('uccTicketId')).toBe('tkt_456');
    expect(url.searchParams.get('tenantId')).toBe('infinize-university');
    expect(args.from).toBe('+15550000000');
    expect(args.record).toBe(true);
  });

  it('hands the department to TaskRouter and does not choose an agent', async () => {
    const { client, captured } = fakeTwilio();
    const p = make(client);

    await p.transferToQueue({ providerContactId: 'CA_live', queueId: 'dept-admissions' });

    expect(captured.tasks).toHaveLength(1);
    const attrs = JSON.parse((captured.tasks[0] as { attributes: string }).attributes);
    expect(attrs.department).toBe('dept-admissions');
    expect(attrs.call_sid).toBe('CA_live');
    // The boundary that matters: no worker/agent is named anywhere in the request.
    expect(JSON.stringify(captured.tasks[0])).not.toMatch(/worker|agent/i);
  });

  it('queues a callback as a routed task, not a bare scheduled dial', async () => {
    const { client, captured } = fakeTwilio();
    const p = make(client);

    const res = await p.createCallback({
      providerContactId: 'CA_orig',
      queueId: 'dept-financial-aid',
      destinationPhoneNumber: '+919812340003',
      scheduledFor: '2026-08-19T10:00:00.000Z',
    });

    expect(res.callbackContactId).toBe('WT_fake_task_sid');
    const attrs = JSON.parse((captured.tasks[0] as { attributes: string }).attributes);
    expect(attrs.type).toBe('callback');
    expect(attrs.department).toBe('dept-financial-aid');
    // Callbacks respect the same routing rules as live contacts.
    expect(attrs.scheduled_for).toBe('2026-08-19T10:00:00.000Z');
  });

  it('ends the correct call', async () => {
    const { client, captured } = fakeTwilio();
    await make(client).stopContact({ providerContactId: 'CA_to_end' });
    expect(captured.calls.endedSid).toBe('CA_to_end');
    expect(captured.calls.update[0]).toEqual({ status: 'completed' });
  });

  it('returns null when no recording exists yet rather than inventing one', async () => {
    const { client } = fakeTwilio({ recordings: [] });
    expect(await make(client).getRecordingLocation({ providerContactId: 'CA_x' })).toBeNull();
  });

  it('returns the recording location and duration when one exists', async () => {
    const { client } = fakeTwilio({ recordings: [{ sid: 'RE_abc', duration: '42' }] });
    const loc = await make(client).getRecordingLocation({ providerContactId: 'CA_x' });
    expect(loc).toEqual({
      storageLocation: 'https://api.twilio.com/2010-04-01/Accounts/AC_test/Recordings/RE_abc',
      duration: 42,
    });
  });

  it('fails loudly when TaskRouter is not configured, rather than half-routing', async () => {
    const { client } = fakeTwilio();
    const p = new TwilioProvider('AC_test', 'tok', '+15550000000', undefined, undefined, 'https://x.test', true, client);
    await expect(
      p.transferToQueue({ providerContactId: 'CA_live', queueId: 'dept-admissions' }),
    ).rejects.toThrow(/TWILIO_WORKSPACE_SID/);
  });

  it('fails loudly when no public base URL is set for outbound', async () => {
    const { client } = fakeTwilio();
    const p = new TwilioProvider('AC_test', 'tok', '+15550000000', 'WS', 'WW', undefined, true, client);
    await expect(
      p.startOutboundContact({ destinationPhoneNumber: '+919812340005', attributes: {} }),
    ).rejects.toThrow(/PUBLIC_BASE_URL/);
  });

  it('never writes a full phone number to the logs', async () => {
    const { client } = fakeTwilio();
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });

    await make(client).startOutboundContact({
      destinationPhoneNumber: '+919812340005',
      attributes: { uccCallId: 'call_1' },
    });

    spy.mockRestore();
    const all = logged.join('\n');
    expect(all).not.toContain('+919812340005');
    expect(all).not.toContain('9812340005');
  });
  describe('when UCC owns routing', () => {
    it('creates no TaskRouter task — UCC already picked the agent', async () => {
      const { client, captured } = fakeTwilio();
      await makeUccRouted(client).transferToQueue({
        providerContactId: 'CA_live',
        queueId: 'dept-admissions',
      });
      // A task nobody consumes would leave an orphaned reservation and a second,
      // competing view of agent state — the defect that motivated this switch.
      expect(captured.tasks).toHaveLength(0);
    });

    it('queues a callback without TaskRouter', async () => {
      const { client, captured } = fakeTwilio();
      const res = await makeUccRouted(client).createCallback({
        providerContactId: 'CA_orig',
        queueId: 'dept-general',
        destinationPhoneNumber: '+919812340003',
        scheduledFor: '2026-08-19T10:00:00.000Z',
      });
      expect(captured.tasks).toHaveLength(0);
      expect(res.callbackContactId).toContain('CA_orig');
    });

    it('still ends calls and reads recordings normally', async () => {
      const { client, captured } = fakeTwilio({ recordings: [{ sid: 'RE_1', duration: '10' }] });
      const p = makeUccRouted(client);
      await p.stopContact({ providerContactId: 'CA_end' });
      expect(captured.calls.endedSid).toBe('CA_end');
      expect(await p.getRecordingLocation({ providerContactId: 'CA_end' })).not.toBeNull();
    });
  });
});
