import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { AmazonConnectProvider } from './amazon-connect-provider.ts';
import { SimulatedConnectProvider } from './simulated-provider.ts';
import type { TelephonyProvider } from './provider.ts';

export * from './provider.ts';
export * from './amazon-connect-provider.ts';
export * from './simulated-provider.ts';

/**
 * Select the telephony adapter from configuration.
 *
 * Amazon Connect is used when `UCC_TELEPHONY=connect` and an instance id is configured.
 * Otherwise the simulator is used and the reason is logged loudly, so nobody mistakes a
 * simulated run for a live telephony run.
 */
export function createTelephonyProvider(): TelephonyProvider {
  const cfg = config();
  if (cfg.UCC_TELEPHONY === 'connect' && cfg.CONNECT_INSTANCE_ID) {
    logger.info('Telephony provider: Amazon Connect (live)', {
      instanceId: cfg.CONNECT_INSTANCE_ID,
    });
    return new AmazonConnectProvider(
      cfg.CONNECT_INSTANCE_ID,
      cfg.CONNECT_CONTACT_FLOW_ID ?? '',
      cfg.CONNECT_SOURCE_PHONE_NUMBER ?? '',
      cfg.AWS_REGION,
    );
  }
  logger.warn(
    'Telephony provider: SIMULATED. No Amazon Connect instance configured — telephony is mocked, all other layers are real.',
  );
  return new SimulatedConnectProvider();
}
