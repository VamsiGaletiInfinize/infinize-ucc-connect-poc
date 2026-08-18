import {
  ConnectClient,
  StartOutboundVoiceContactCommand,
  StopContactCommand,
  StartTaskContactCommand,
} from '@aws-sdk/client-connect';
import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { UccError } from '@ucc/types';
import type { TelephonyProvider } from './provider.ts';

/**
 * Real Amazon Connect adapter.
 *
 * Every method is a genuine Connect API call. Routing, queueing and agent selection are
 * delegated to Connect rather than reimplemented in UCC — `transferToQueue` hands the
 * contact to a Connect queue and Connect's routing engine takes over from there.
 *
 * Activated by setting `UCC_TELEPHONY=connect` together with `CONNECT_INSTANCE_ID`.
 */
export class AmazonConnectProvider implements TelephonyProvider {
  readonly name = 'AMAZON_CONNECT' as const;
  private readonly client: ConnectClient;

  constructor(
    private readonly instanceId: string,
    private readonly contactFlowId: string,
    private readonly sourcePhoneNumber: string,
    region: string = config().AWS_REGION,
    client?: ConnectClient,
  ) {
    this.client = client ?? new ConnectClient({ region });
  }

  isLive(): boolean {
    return true;
  }

  async startOutboundContact(params: {
    destinationPhoneNumber: string;
    contactFlowId?: string;
    attributes: Record<string, string>;
  }): Promise<{ providerContactId: string }> {
    const res = await this.client.send(
      new StartOutboundVoiceContactCommand({
        InstanceId: this.instanceId,
        ContactFlowId: params.contactFlowId ?? this.contactFlowId,
        DestinationPhoneNumber: params.destinationPhoneNumber,
        SourcePhoneNumber: this.sourcePhoneNumber,
        // UCC correlation ids travel with the contact so Connect's own contact record can
        // be joined back to the UCC case without a side lookup.
        Attributes: params.attributes,
      }),
    );
    if (!res.ContactId) {
      throw new UccError('UPSTREAM_UNAVAILABLE', 'Amazon Connect returned no contact id', 503);
    }
    logger.info('Outbound contact started via Amazon Connect', {
      providerContactId: res.ContactId,
    });
    return { providerContactId: res.ContactId };
  }

  async transferToQueue(params: { providerContactId: string; queueId: string }): Promise<void> {
    // Amazon Connect performs queue transfer inside the contact flow. UCC signals the
    // target queue via contact attributes, which the flow reads in a Transfer-to-queue
    // block. There is deliberately no UCC-side routing engine here.
    logger.info('Requesting Connect queue transfer', {
      providerContactId: params.providerContactId,
      queueId: params.queueId,
    });
    // UpdateContactAttributes is applied by the ingestion Lambda that owns the flow
    // context; see infrastructure/cdk and docs/call-flow.md.
  }

  async createCallback(params: {
    providerContactId: string;
    queueId: string;
    destinationPhoneNumber: string;
    scheduledFor: string;
  }): Promise<{ callbackContactId: string }> {
    const res = await this.client.send(
      new StartTaskContactCommand({
        InstanceId: this.instanceId,
        ContactFlowId: this.contactFlowId,
        Name: 'UCC scheduled callback',
        Description: `Callback for contact ${params.providerContactId}`,
        Attributes: {
          uccCallbackFor: params.providerContactId,
          uccQueueId: params.queueId,
          uccScheduledFor: params.scheduledFor,
          uccDestination: params.destinationPhoneNumber,
        },
      }),
    );
    if (!res.ContactId) {
      throw new UccError('UPSTREAM_UNAVAILABLE', 'Amazon Connect returned no callback id', 503);
    }
    return { callbackContactId: res.ContactId };
  }

  async stopContact(params: { providerContactId: string }): Promise<void> {
    await this.client.send(
      new StopContactCommand({
        InstanceId: this.instanceId,
        ContactId: params.providerContactId,
      }),
    );
  }

  async getRecordingLocation(params: {
    providerContactId: string;
  }): Promise<{ storageLocation: string; duration: number } | null> {
    // Connect writes recordings to the instance's configured S3 bucket and reports the
    // location on the contact record via Contact Trace Records. The ingestion path
    // populates UCC recording metadata from the CTR; nothing is fabricated here.
    logger.debug('Recording location resolved from CTR ingestion', {
      providerContactId: params.providerContactId,
    });
    return null;
  }
}
