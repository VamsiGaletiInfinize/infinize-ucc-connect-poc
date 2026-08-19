import { UccError, notFound, type VerificationSession } from '@ucc/types';
import { config } from '@ucc/config';
import { hashSecret, logger, maskPhone, newId, nowIso, safeEqual } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { EventService } from '@ucc/services/events';

/**
 * DEMO ONLY — the POC accepts a single fixed one-time passcode.
 *
 * Production replacement: generate a cryptographically random 6-digit code per session and
 * deliver it via Amazon Pinpoint / SNS to the number registered on the application. The
 * surrounding lifecycle implemented here (hashing, expiry, attempt limit, single use,
 * binding to one call) is already production-shaped and does not change.
 */
export const DEMO_OTP = '123456';
export const DEMO_OTP_NOTICE = 'POC MOCK: fixed demo passcode 123456. Not for production use.';

const OTP_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 3;

export interface VerificationChallenge {
  sessionId: string;
  maskedDestination: string;
  expiresAt: string;
  /** Surfaced to the demo UI so the operator knows what to enter. Never logged. */
  demoNotice: string;
}

export class VerificationService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
  ) {}

  /**
   * Issue a challenge for a call.
   *
   * The code is hashed before storage and never logged, never returned in an API
   * response, and never placed on the event timeline.
   */
  async requestVerification(params: {
    tenantId: string;
    uccCallId: string;
    uccTicketId: string;
    callerId: string;
    destination: string;
    channel?: 'SMS' | 'EMAIL';
    traceId: string;
  }): Promise<VerificationChallenge> {
    const now = Date.now();
    const session: VerificationSession = {
      id: newId('vrf'),
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      callerId: params.callerId,
      otpHash: hashSecret(DEMO_OTP, config().VERIFICATION_SALT),
      status: 'PENDING',
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      deliveryChannel: params.channel ?? 'SMS',
      maskedDestination: maskPhone(params.destination),
      expiresAt: new Date(now + OTP_TTL_SECONDS * 1000).toISOString(),
      createdAt: nowIso(),
    };

    await this.repos.verification.put(session);

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'VERIFICATION_REQUIRED',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: session.id,
      payload: { sessionId: session.id },
    });

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'OTP_SENT',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: session.id,
      // Only the masked destination is recorded. The code itself never appears anywhere.
      payload: { channel: session.deliveryChannel, maskedDestination: session.maskedDestination },
    });

    logger.info('Verification challenge issued', {
      traceId: params.traceId,
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      sessionId: session.id,
    });

    return {
      sessionId: session.id,
      maskedDestination: session.maskedDestination,
      expiresAt: session.expiresAt,
      demoNotice: DEMO_OTP_NOTICE,
    };
  }

  /**
   * Verify a submitted code.
   *
   * Enforces expiry, attempt limit and single use. A session that has already succeeded
   * cannot be replayed, and a session bound to one call cannot verify another.
   */
  async verify(params: {
    tenantId: string;
    uccCallId: string;
    uccTicketId: string;
    sessionId: string;
    code: string;
    traceId: string;
  }): Promise<{ verified: boolean; reason: string }> {
    const session = await this.repos.verification.get(params.tenantId, params.sessionId);
    if (!session) throw notFound('Verification session', params.sessionId);

    // A session is bound to exactly one call. This blocks lifting a verification from
    // one contact and replaying it on another.
    if (session.uccCallId !== params.uccCallId) {
      throw new UccError(
        'NOT_AUTHORIZED',
        'Verification session does not belong to this call',
        403,
      );
    }

    if (session.status === 'VERIFIED') {
      return { verified: true, reason: 'Already verified' };
    }

    if (Date.now() > Date.parse(session.expiresAt)) {
      await this.repos.verification.put({ ...session, status: 'EXPIRED' });
      await this.emitFailure(params, 'EXPIRED');
      return { verified: false, reason: 'The passcode has expired. Request a new one.' };
    }

    if (session.attempts >= session.maxAttempts) {
      await this.repos.verification.put({ ...session, status: 'FAILED' });
      await this.emitFailure(params, 'ATTEMPTS_EXCEEDED');
      return { verified: false, reason: 'Too many incorrect attempts. Request a new passcode.' };
    }

    const attempts = session.attempts + 1;
    const submittedHash = hashSecret(String(params.code ?? ''), config().VERIFICATION_SALT);
    const matches = safeEqual(submittedHash, session.otpHash);

    if (!matches) {
      const exhausted = attempts >= session.maxAttempts;
      await this.repos.verification.put({
        ...session,
        attempts,
        status: exhausted ? 'FAILED' : 'PENDING',
      });
      await this.emitFailure(params, 'INCORRECT_CODE');
      return {
        verified: false,
        reason: exhausted
          ? 'Too many incorrect attempts. Request a new passcode.'
          : `That passcode was not correct. ${session.maxAttempts - attempts} attempt(s) remaining.`,
      };
    }

    await this.repos.verification.put({
      ...session,
      attempts,
      status: 'VERIFIED',
      verifiedAt: nowIso(),
    });

    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'IDENTITY_VERIFIED',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: session.id,
      payload: { sessionId: session.id, callerId: session.callerId },
    });

    logger.info('Identity verified', {
      traceId: params.traceId,
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      sessionId: session.id,
    });

    return { verified: true, reason: 'Identity verified' };
  }

  private async emitFailure(
    params: { tenantId: string; uccCallId: string; uccTicketId: string; traceId: string; sessionId: string },
    code: string,
  ): Promise<void> {
    await this.events.emit({
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      uccTicketId: params.uccTicketId,
      type: 'IDENTITY_FAILED',
      actor: 'SYSTEM',
      traceId: params.traceId,
      discriminator: `${params.sessionId}:${code}:${Date.now()}`,
      payload: { reason: code },
    });
  }

  /** Persisted verification state for a call — the ONLY source of `verified`. */
  async isCallVerified(tenantId: string, uccCallId: string): Promise<boolean> {
    return (await this.repos.verification.verifiedForCall(tenantId, uccCallId)) !== null;
  }

  activeSession(tenantId: string, uccCallId: string) {
    return this.repos.verification.activeForCall(tenantId, uccCallId);
  }
}

export * from './session-token.ts';
