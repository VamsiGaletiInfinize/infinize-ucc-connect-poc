import type { CallerType } from './domain.ts';

/**
 * The security context for a single contact.
 *
 * CRITICAL (constitution Principle III): this object is derived exclusively from
 * server-side persisted state — resolved caller record, stored verification session,
 * tenant of the call. It is NEVER constructed from anything the language model said.
 *
 * Tools receive this context; they do not receive, and cannot influence, the caller's
 * verification state through conversation.
 */
export interface CallSecurityContext {
  tenantId: string;
  uccCallId: string;
  uccTicketId: string;
  /** Resolved UCC caller id, absent when the ANI could not be matched. */
  callerId?: string;
  callerType: CallerType;
  /** True only when a VerificationSession for THIS call reached VERIFIED. */
  verified: boolean;
  /** Student id the verified caller is acting as, if any. */
  verifiedStudentId?: string;
  traceId: string;
}

export type AuthorizationEffect = 'ALLOW' | 'DENY';

/**
 * The outcome of a server-side authorization check.
 *
 * `reason` is safe to read back to the caller; it explains what is required without
 * disclosing whether the protected resource exists.
 */
export interface AuthorizationDecision {
  effect: AuthorizationEffect;
  reason: string;
  /** Set when denial is remediable by verifying identity. */
  requiresVerification?: boolean;
  /** Stable code for audit and tests. */
  code:
    | 'ALLOWED'
    | 'UNKNOWN_CALLER'
    | 'NOT_VERIFIED'
    | 'CALLER_TYPE_NOT_PERMITTED'
    | 'NOT_RESOURCE_OWNER'
    | 'TENANT_MISMATCH';
}

export const allow = (reason = 'Authorized'): AuthorizationDecision => ({
  effect: 'ALLOW',
  reason,
  code: 'ALLOWED',
});

export const deny = (
  code: Exclude<AuthorizationDecision['code'], 'ALLOWED'>,
  reason: string,
  requiresVerification = false,
): AuthorizationDecision => ({
  effect: 'DENY',
  reason,
  code,
  requiresVerification,
});
