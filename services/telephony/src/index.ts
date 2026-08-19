import { config } from '@ucc/config';
import { logger } from '@ucc/shared';
import { AmazonConnectProvider } from './amazon-connect-provider.ts';
import { SimulatedConnectProvider } from './simulated-provider.ts';
import { TwilioProvider } from './twilio-provider.ts';
import type { TelephonyProvider } from './provider.ts';

export * from './provider.ts';
export * from './amazon-connect-provider.ts';
export * from './simulated-provider.ts';
export * from './twilio-provider.ts';

/**
 * Select the telephony adapter from configuration.
 *
 * Twilio is used when `UCC_TELEPHONY=twilio` and credentials are configured. Amazon
 * Connect is used when `UCC_TELEPHONY=connect` and an instance id is configured.
 * Otherwise the simulator is used and the reason is logged loudly, so nobody mistakes a
 * simulated run for a live telephony run.
 *
 * Misconfiguration fails loudly rather than degrading silently: asking for a live provider
 * and getting the simulator without noticing is exactly how a demo goes wrong.
 */
export function createTelephonyProvider(): TelephonyProvider {
  const cfg = config();

  if (cfg.UCC_TELEPHONY === 'twilio') {
    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) {
      throw new Error(
        'UCC_TELEPHONY=twilio requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN. ' +
          'Refusing to fall back to the simulator silently.',
      );
    }
    const useTaskRouter = cfg.UCC_ROUTING === 'taskrouter';
    if (useTaskRouter && !cfg.TWILIO_WORKSPACE_SID) {
      throw new Error(
        'UCC_ROUTING=taskrouter requires TWILIO_WORKSPACE_SID and TWILIO_WORKFLOW_SID.',
      );
    }
    logger.info('Telephony provider: Twilio (live)', {
      phoneNumber: cfg.TWILIO_PHONE_NUMBER ? 'configured' : 'MISSING',
      routing: useTaskRouter ? 'TaskRouter owns the queue' : 'UCC owns the queue',
    });
    return new TwilioProvider(
      cfg.TWILIO_ACCOUNT_SID,
      cfg.TWILIO_AUTH_TOKEN,
      cfg.TWILIO_PHONE_NUMBER ?? '',
      cfg.TWILIO_WORKSPACE_SID,
      cfg.TWILIO_WORKFLOW_SID,
      cfg.PUBLIC_BASE_URL,
      useTaskRouter,
    );
  }

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
