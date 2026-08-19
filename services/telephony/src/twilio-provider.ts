import twilio from 'twilio';
import type { Twilio } from 'twilio';
import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { UccError } from '@ucc/types';
import type { TelephonyProvider } from './provider.ts';

/**
 * Real Twilio adapter.
 *
 * WHY TWILIO
 * ----------
 * Amazon Connect instance creation is denied org-wide by SCP `p-qocf1ngi` (ADR-0004), and
 * the denial reproduces for every principal available to us including CloudFormation.
 * Twilio provides the same three capabilities Connect would have owned:
 *
 *   telephony          Programmable Voice
 *   queue + routing    TaskRouter (workers, task queues, workflows, reservations)
 *   agent voice        Voice JS SDK — the agent's browser becomes the endpoint
 *
 * Bedrock still performs all reasoning, so caller utterances are never sent to a
 * third-party model. Twilio sees the audio because it is the carrier; it would see it on
 * any telephony path.
 *
 * WHO OWNS QUEUEING — CONFIGURABLE
 * --------------------------------
 * `UCC_ROUTING` selects between two models, and only one may be active:
 *
 *   'ucc'         UCC picks the department AND the agent, using the queue, presence and
 *                 capacity rules in `services/routing`. Twilio is asked only to connect
 *                 the call to that person. `transferToQueue` becomes a no-op here.
 *
 *   'taskrouter'  TaskRouter owns the queue and selects the worker; UCC supplies only the
 *                 department. This matches the original Amazon Connect boundary.
 *
 * Running both produced a real defect: UCC assigned an agent and reported AGENT_CONNECTED
 * while TaskRouter had no worker registered, so the supervisor dashboard showed a
 * connection that did not exist and the caller was never transferred. Agent state must
 * have exactly one owner.
 *
 * Activated by `UCC_TELEPHONY=twilio` with `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
 */
export class TwilioProvider implements TelephonyProvider {
  readonly name = 'TWILIO' as const;
  private readonly client: Twilio;

  constructor(
    private readonly accountSid: string,
    authToken: string,
    private readonly sourcePhoneNumber: string,
    private readonly workspaceSid: string | undefined,
    private readonly workflowSid: string | undefined,
    private readonly publicBaseUrl: string | undefined,
    /**
     * True only when TaskRouter owns queueing. When UCC owns it, this adapter must not
     * create TaskRouter tasks — a task nobody consumes leaves an orphaned reservation and
     * a second, competing view of agent state.
     */
    private readonly useTaskRouter: boolean,
    client?: Twilio,
  ) {
    this.client = client ?? twilio(accountSid, authToken);
  }

  isLive(): boolean {
    return true;
  }

  /**
   * Place an outbound call.
   *
   * UCC ids travel as query parameters on the answer URL rather than as call metadata,
   * because Twilio has no direct equivalent of Connect's contact attributes. The webhook
   * therefore recovers the correlation ids without a database lookup.
   */
  async startOutboundContact(params: {
    destinationPhoneNumber: string;
    contactFlowId?: string;
    attributes: Record<string, string>;
  }): Promise<{ providerContactId: string }> {
    if (!this.publicBaseUrl) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'PUBLIC_BASE_URL must be set for outbound calls — Twilio needs a reachable answer URL.',
        500,
      );
    }

    const url = new URL('/twilio/voice/outbound', this.publicBaseUrl);
    for (const [k, v] of Object.entries(params.attributes)) url.searchParams.set(k, v);

    const call = await this.client.calls.create({
      to: params.destinationPhoneNumber,
      from: this.sourcePhoneNumber,
      url: url.toString(),
      // Twilio reports progress here; the event route normalizes it onto the UCC timeline.
      statusCallback: new URL('/twilio/voice/status', this.publicBaseUrl).toString(),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      // Recording is enabled at the call level so it covers both AI and agent segments.
      record: true,
    });

    logger.info('Twilio outbound call created', {
      providerContactId: call.sid,
      to: redactPhone(params.destinationPhoneNumber),
    });
    return { providerContactId: call.sid };
  }

  /**
   * Hand the contact to a department queue.
   *
   * A TaskRouter *task* is created carrying the UCC correlation ids and the department.
   * The workflow — not UCC — decides which worker receives it. The live call is then
   * redirected into a conference that the accepting worker joins, which is Twilio's
   * recommended bridging pattern.
   */
  async transferToQueue(params: { providerContactId: string; queueId: string }): Promise<void> {
    if (!this.useTaskRouter) {
      // UCC has already chosen the department AND the agent. The live call is bridged to
      // that specific person by the handoff TwiML (`<Dial><Client>`), so there is nothing
      // to enqueue here. Creating a task anyway would fork agent state.
      logger.info('Queue transfer handled by UCC routing; no TaskRouter task created', {
        providerContactId: params.providerContactId,
        queueId: params.queueId,
      });
      return;
    }
    if (!this.workspaceSid || !this.workflowSid) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'TWILIO_WORKSPACE_SID and TWILIO_WORKFLOW_SID are required to route to a queue.',
        500,
      );
    }

    await this.client.taskrouter.v1
      .workspaces(this.workspaceSid)
      .tasks.create({
        workflowSid: this.workflowSid,
        // The workflow matches on these attributes to pick the right queue.
        attributes: JSON.stringify({
          department: params.queueId,
          call_sid: params.providerContactId,
          type: 'voice',
        }),
      });

    logger.info('Twilio TaskRouter task created', {
      providerContactId: params.providerContactId,
      queueId: params.queueId,
    });
  }

  /**
   * Queue a callback.
   *
   * Modelled as a TaskRouter task rather than a scheduled outbound call, so callbacks sit
   * in the same queue as live contacts and respect the same routing rules. The agent's
   * acceptance triggers the outbound leg.
   */
  async createCallback(params: {
    providerContactId: string;
    queueId: string;
    destinationPhoneNumber: string;
    scheduledFor: string;
  }): Promise<{ callbackContactId: string }> {
    if (!this.useTaskRouter) {
      // UCC already persists the callback and owns its lifecycle; the outbound leg is
      // placed when an agent accepts it.
      const id = `ucc-callback:${params.providerContactId}`;
      logger.info('Callback queued by UCC routing', {
        callbackContactId: id,
        queueId: params.queueId,
      });
      return { callbackContactId: id };
    }
    if (!this.workspaceSid || !this.workflowSid) {
      throw new UccError(
        'CONFIGURATION_ERROR',
        'TWILIO_WORKSPACE_SID and TWILIO_WORKFLOW_SID are required to queue a callback.',
        500,
      );
    }

    const task = await this.client.taskrouter.v1
      .workspaces(this.workspaceSid)
      .tasks.create({
        workflowSid: this.workflowSid,
        attributes: JSON.stringify({
          department: params.queueId,
          type: 'callback',
          phone: params.destinationPhoneNumber,
          scheduled_for: params.scheduledFor,
          originating_call_sid: params.providerContactId,
        }),
      });

    logger.info('Twilio callback task queued', {
      callbackContactId: task.sid,
      queueId: params.queueId,
    });
    return { callbackContactId: task.sid };
  }

  async stopContact(params: { providerContactId: string }): Promise<void> {
    await this.client.calls(params.providerContactId).update({ status: 'completed' });
    logger.info('Twilio call ended', { providerContactId: params.providerContactId });
  }

  /**
   * Recording location for a completed call.
   *
   * Returns the Twilio media URI rather than an S3 key. Recording binaries stay with the
   * carrier for the POC; production should copy them into the UCC bucket so retention is
   * governed in one place (spec FR-015).
   */
  async getRecordingLocation(params: {
    providerContactId: string;
  }): Promise<{ storageLocation: string; duration: number } | null> {
    const recordings = await this.client.recordings.list({
      callSid: params.providerContactId,
      limit: 1,
    });
    const recording = recordings[0];
    if (!recording) return null;

    return {
      storageLocation: `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${recording.sid}`,
      duration: Number(recording.duration ?? 0),
    };
  }
}

/** Never log a full phone number; the last four digits are enough to correlate. */
function redactPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `***${phone.slice(-4)}`;
}
