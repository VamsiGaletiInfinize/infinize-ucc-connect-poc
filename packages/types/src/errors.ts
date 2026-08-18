/**
 * Typed error taxonomy.
 *
 * Every error carries a stable machine-readable `code` and an HTTP status so the API
 * layer never has to guess. Messages are safe to surface to a caller: they never contain
 * OTP values, credentials, or unnecessary PII.
 */

export type UccErrorCode =
  | 'INVALID_TICKET_TRANSITION'
  | 'NOT_FOUND'
  | 'TENANT_MISMATCH'
  | 'VERIFICATION_REQUIRED'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_EXPIRED'
  | 'VERIFICATION_ATTEMPTS_EXCEEDED'
  | 'NOT_AUTHORIZED'
  | 'AMBIGUOUS_RESOURCE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'IMMUTABLE_FIELD';

export class UccError extends Error {
  readonly code: UccErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: UccErrorCode,
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UccError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string, id: string) =>
  new UccError('NOT_FOUND', `${what} ${id} not found`, 404);

/** Cross-tenant access attempt. Deliberately reported as 404 to avoid confirming existence. */
export const tenantMismatch = (what: string) =>
  new UccError(
    'TENANT_MISMATCH',
    `${what} not found in this tenant`,
    404,
  );

export const verificationRequired = (reason: string) =>
  new UccError('VERIFICATION_REQUIRED', reason, 403);

export const notAuthorized = (reason: string) =>
  new UccError('NOT_AUTHORIZED', reason, 403);

export const ambiguous = (reason: string, options: unknown[]) =>
  new UccError('AMBIGUOUS_RESOURCE', reason, 409, { options });

export const upstreamUnavailable = (system: string) =>
  new UccError(
    'UPSTREAM_UNAVAILABLE',
    `${system} is currently unavailable`,
    503,
  );

export const validationFailed = (reason: string, details?: Record<string, unknown>) =>
  new UccError('VALIDATION_FAILED', reason, 400, details);
