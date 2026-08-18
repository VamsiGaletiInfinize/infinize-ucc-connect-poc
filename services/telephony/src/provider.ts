import type { CallDirection, TelephonyProviderName } from '@ucc/types';

/**
 * The telephony port.
 *
 * UCC talks to the contact centre platform ONLY through this interface. Amazon Connect
 * owns telephony, queues, routing profiles and agent state (constitution Principle I);
 * UCC never reimplements them, it asks the provider to perform them.
 *
 * Two adapters implement this port:
 *   - `AmazonConnectProvider`  — real Amazon Connect SDK calls
 *   - `SimulatedConnectProvider` — emits byte-identical normalized events without telephony
 *
 * The simulator exists because the target AWS account blocks Amazon Connect instance
 * creation at the organisation level (ADR-0004). Switching adapters is a configuration
 * change, not a code change.
 */
export interface TelephonyProvider {
  readonly name: TelephonyProviderName;

  /** True when the adapter is backed by a live contact centre instance. */
  isLive(): boolean;

  /** Place an outbound voice contact. Returns the provider contact id. */
  startOutboundContact(params: {
    destinationPhoneNumber: string;
    contactFlowId?: string;
    /** Attributes attached to the contact so UCC ids survive into the contact record. */
    attributes: Record<string, string>;
  }): Promise<{ providerContactId: string }>;

  /** Transfer a live contact to a queue. Amazon Connect performs the actual routing. */
  transferToQueue(params: {
    providerContactId: string;
    queueId: string;
  }): Promise<void>;

  /** Enqueue a callback contact. */
  createCallback(params: {
    providerContactId: string;
    queueId: string;
    destinationPhoneNumber: string;
    scheduledFor: string;
  }): Promise<{ callbackContactId: string }>;

  /** Stop a contact. */
  stopContact(params: { providerContactId: string }): Promise<void>;

  /** Where the recording for a contact lives, once available. */
  getRecordingLocation(params: {
    providerContactId: string;
  }): Promise<{ storageLocation: string; duration: number } | null>;
}

/** Provider-agnostic description of an inbound contact arriving at UCC. */
export interface InboundContactEvent {
  providerContactId: string;
  direction: CallDirection;
  callerPhoneNumber: string;
  /** Number the caller dialled, used to resolve the tenant in a multi-tenant deployment. */
  dialedNumber?: string;
  /** Provider event id, used as the idempotency discriminator. */
  providerEventId: string;
  occurredAt: string;
  attributes?: Record<string, string>;
}
