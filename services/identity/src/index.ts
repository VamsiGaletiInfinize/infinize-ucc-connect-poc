import {
  SELF_SERVICE_CALLER_TYPES,
  allow,
  deny,
  type Application,
  type AuthorizationDecision,
  type CallSecurityContext,
  type Caller,
  type UccCall,
} from '@ucc/types';
import { logger } from '@ucc/shared';
import type { Repositories } from '@ucc/services/store';
import type { VerificationService } from '@ucc/services/verification';

/**
 * Identity resolution and the server-side authorization gate.
 *
 * CONSTITUTION PRINCIPLE III — this module is the reason the POC is safe. Every protected
 * operation calls `authorizeApplicationAccess` with a `CallSecurityContext` that this
 * module builds from PERSISTED state. Nothing the language model says can influence the
 * outcome: the model cannot set `verified`, cannot change `callerId`, and cannot widen
 * `tenantId`.
 */
export class IdentityService {
  constructor(
    private readonly repos: Repositories,
    private readonly verification: VerificationService,
  ) {}

  /** Resolve a caller from the calling number (ANI). Unknown numbers are not an error. */
  async resolveCallerByPhone(tenantId: string, phone: string): Promise<Caller | null> {
    const caller = await this.repos.caller.byPhone(tenantId, phone);
    if (!caller) {
      logger.info('Caller not recognised from ANI', { tenantId, phone });
      return null;
    }
    return caller;
  }

  /**
   * Build the security context for a call.
   *
   * `verified` is read from the stored VerificationSession for THIS call — never passed
   * in, never inferred from conversation.
   */
  async buildSecurityContext(call: UccCall, uccTicketId: string): Promise<CallSecurityContext> {
    const verified = await this.verification.isCallVerified(call.tenantId, call.id);
    const caller = call.callerRefId
      ? await this.repos.caller.get(call.tenantId, call.callerRefId)
      : null;

    return {
      tenantId: call.tenantId,
      uccCallId: call.id,
      uccTicketId,
      callerId: caller?.id,
      callerType: caller?.callerType ?? call.callerType,
      verified,
      verifiedStudentId: verified ? caller?.studentId : undefined,
      traceId: call.traceId,
    };
  }

  async getCaller(tenantId: string, callerId: string): Promise<Caller | null> {
    return this.repos.caller.get(tenantId, callerId);
  }

  /**
   * Decide whether this contact may read this application.
   *
   * Checks, in order and all server-side:
   *   1. the caller was actually identified
   *   2. identity has been verified on THIS call
   *   3. the caller type is permitted to access records at all
   *   4. the application belongs to this tenant
   *   5. the caller owns the record, or is an authorised guardian of its owner
   */
  async authorizeApplicationAccess(
    ctx: CallSecurityContext,
    application: Application,
  ): Promise<AuthorizationDecision> {
    if (!ctx.callerId) {
      return deny(
        'UNKNOWN_CALLER',
        'We could not identify you from this number, so application details cannot be shared.',
        true,
      );
    }

    if (!ctx.verified) {
      return deny(
        'NOT_VERIFIED',
        'Identity verification is required before application details can be shared.',
        true,
      );
    }

    // Defence in depth: the repository is already tenant-partitioned, so this should be
    // unreachable. It stays because a future non-partitioned read path must still fail closed.
    if (application.tenantId !== ctx.tenantId) {
      logger.warn('Cross-tenant application access attempt blocked', {
        traceId: ctx.traceId,
        tenantId: ctx.tenantId,
        uccCallId: ctx.uccCallId,
        applicationTenantId: application.tenantId,
      });
      return deny('TENANT_MISMATCH', 'That record could not be found for this institution.');
    }

    const caller = await this.repos.caller.get(ctx.tenantId, ctx.callerId);
    if (!caller) {
      return deny('UNKNOWN_CALLER', 'Caller record could not be resolved.', true);
    }

    const isOwner =
      SELF_SERVICE_CALLER_TYPES.includes(caller.callerType) &&
      caller.studentId === application.studentId;

    const isAuthorisedGuardian =
      (caller.callerType === 'PARENT' || caller.callerType === 'GUARDIAN') &&
      (caller.relatedStudentIds ?? []).includes(application.studentId);

    if (!isOwner && !isAuthorisedGuardian) {
      logger.warn('Application access denied: not the record owner', {
        traceId: ctx.traceId,
        tenantId: ctx.tenantId,
        uccCallId: ctx.uccCallId,
        callerType: caller.callerType,
      });
      return deny(
        'NOT_RESOURCE_OWNER',
        'You are not authorised to access this application record.',
      );
    }

    if (
      !SELF_SERVICE_CALLER_TYPES.includes(caller.callerType) &&
      !isAuthorisedGuardian
    ) {
      return deny(
        'CALLER_TYPE_NOT_PERMITTED',
        'This caller type cannot access application records.',
      );
    }

    return allow();
  }

  /** Student ids this contact may enquire about, after verification. */
  async accessibleStudentIds(ctx: CallSecurityContext): Promise<string[]> {
    if (!ctx.verified || !ctx.callerId) return [];
    const caller = await this.repos.caller.get(ctx.tenantId, ctx.callerId);
    if (!caller) return [];
    const own = caller.studentId ? [caller.studentId] : [];
    const related =
      caller.callerType === 'PARENT' || caller.callerType === 'GUARDIAN'
        ? (caller.relatedStudentIds ?? [])
        : [];
    return [...new Set([...own, ...related])];
  }
}
