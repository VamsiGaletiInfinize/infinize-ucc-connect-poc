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
 * BOUNDARY DISCIPLINE
 * -------------------
 * The ownership rule from the constitution is unchanged, only the provider differs: the
 * platform owns queueing and agent selection, UCC decides only *which department* a
 * contact belongs to. `transferToQueue` hands the contact to TaskRouter and TaskRouter's
 * workflow picks the worker — UCC never selects an agent itself.
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
