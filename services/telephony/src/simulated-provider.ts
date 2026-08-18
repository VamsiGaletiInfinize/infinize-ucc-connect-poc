import { randomUUID } from 'node:crypto';
import { logger } from '@ucc/shared';
import type { TelephonyProvider } from './provider.ts';

/**
 * Simulated contact centre adapter.
 *
 * POC MOCK — telephony only. This adapter produces the same provider contact ids, the same
 * normalized events and the same call/ticket lifecycle as the Amazon Connect adapter; what
 * it does NOT do is carry audio over the PSTN.
 *
 * Why it exists: the target AWS account denies `iam:CreateServiceLinkedRole` for
 * `connect.amazonaws.com` through an organisation SCP, so no Amazon Connect instance can
 * be created (ADR-0004). Everything above the telephony port — AI, verification,
 * authorization, ticketing, routing, agent workflow, supervisor — is exercised for real.
 *
 * Production replacement: set `UCC_TELEPHONY=connect` and supply `CONNECT_INSTANCE_ID`.
 * No application code changes.
 */
export class SimulatedConnectProvider implements TelephonyProvider {
  readonly name = 'SIMULATED_CONNECT' as const;

  /** Queue transfers requested, so the demo and tests can assert routing actually happened. */
  readonly transfers: { providerContactId: string; queueId: string; at: string }[] = [];
  readonly callbacks: { callbackContactId: string; queueId: string; scheduledFor: string }[] = [];
  private readonly stopped = new Set<string>();

  isLive(): boolean {
    return false;
  }

  async startOutboundContact(params: {
    destinationPhoneNumber: string;
    attributes: Record<string, string>;
  }): Promise<{ providerContactId: string }> {
    const providerContactId = randomUUID();
    logger.info('Outbound contact started (simulated telephony)', {
      providerContactId,
      destination: params.destinationPhoneNumber,
    });
    return { providerContactId };
  }

  async transferToQueue(params: { providerContactId: string; queueId: string }): Promise<void> {
    this.transfers.push({ ...params, at: new Date().toISOString() });
    logger.info('Contact transferred to queue (simulated telephony)', params);
  }

  async createCallback(params: {
    providerContactId: string;
    queueId: string;
    destinationPhoneNumber: string;
    scheduledFor: string;
  }): Promise<{ callbackContactId: string }> {
    const callbackContactId = randomUUID();
    this.callbacks.push({
      callbackContactId,
      queueId: params.queueId,
      scheduledFor: params.scheduledFor,
    });
    return { callbackContactId };
  }

  async stopContact(params: { providerContactId: string }): Promise<void> {
    this.stopped.add(params.providerContactId);
  }

  async getRecordingLocation(): Promise<{ storageLocation: string; duration: number } | null> {
    return null;
  }

  wasStopped(providerContactId: string): boolean {
    return this.stopped.has(providerContactId);
  }
}
