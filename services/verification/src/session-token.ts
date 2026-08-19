import { randomBytes } from 'node:crypto';
import { config } from '@ucc/config';
import { hashSecret, newId, nowIso, safeEqual } from '@ucc/shared';
import type { CallSessionToken } from '@ucc/types';
import type { Repositories } from '@ucc/services/store';

/**
 * Per-call session tokens for the external voice pipeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The voice bridge executes privileged tools. A shared service credential proves the caller
 * is the voice pipeline, but it says nothing about *which call* the pipeline is serving —
 * so any holder could read any case by guessing a call id. That is the server-side
 * authorization property of ADR-0002 reopened one layer down.
 *
 * This token closes that: it is minted for exactly one `uccCallId`, hashed before storage,
 * and checked alongside the service credential on every privileged request.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not an identity, and it grants no entitlement to protected data. A verified caller
 * and an unverified caller present the same token; whether the data is disclosed is still
 * decided by the identity gate reading persisted state. This is scope, not permission.
 *
 * THREAT, STATED
 * --------------
 * The token reaches the pipeline inside the TwiML response and returns on the stream start
 * frame, so it transits Twilio. Anyone able to observe either can impersonate that one
 * session, for that one call, until it expires. Acceptable over TLS for a POC with a short
 * lifetime; production should exchange a nonce for a token over a direct channel instead.
 * Recorded in docs/security.md.
 */

/**
 * Comfortably longer than any call this POC will take, so a token never expires mid-call
 * (FR-047). Short enough that a leaked token is not useful for long.
 */
export const SESSION_TOKEN_TTL_SECONDS = 4 * 60 * 60;

export interface IssuedSessionToken {
  /** The plaintext token. Returned once, at mint time, and never persisted or logged. */
  token: string;
  expiresAt: string;
}

export type SessionTokenFailure =
  | 'UNKNOWN_TOKEN'
  | 'WRONG_CALL'
  | 'EXPIRED'
  | 'REVOKED';

export type SessionTokenCheck =
  | { ok: true }
  | { ok: false; reason: SessionTokenFailure };

export class CallSessionTokenService {
  constructor(private readonly repos: Repositories) {}

  /**
   * Mint a token bound to one call.
   *
   * The plaintext is returned to the caller and immediately forgotten here; only a salted
   * hash is stored, so a database read cannot impersonate a stream.
   */
  async issue(params: { tenantId: string; uccCallId: string }): Promise<IssuedSessionToken> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TOKEN_TTL_SECONDS * 1000).toISOString();

    const record: CallSessionToken = {
      id: newId('vst'),
      tenantId: params.tenantId,
      uccCallId: params.uccCallId,
      tokenHash: hashSecret(token, config().VERIFICATION_SALT),
      expiresAt,
      createdAt: nowIso(),
    };

    await this.repos.sessionToken.put(record);
    return { token, expiresAt };
  }

  /**
   * Check a presented token against one call.
   *
   * Returns a reason rather than a boolean so the route can distinguish "not a token we
   * issued" from "a valid token for a different case" — the second is an attempt to reach
   * across cases and deserves to be visible in the logs.
   *
   * Comparison is over hashes using a timing-safe equality, and the candidate set is
   * restricted to tokens issued for the call being requested, so a token for another call
   * can never match here even before the binding check.
   */
  async check(params: {
    tenantId: string;
    uccCallId: string;
    token: string;
  }): Promise<SessionTokenCheck> {
    if (!params.token) return { ok: false, reason: 'UNKNOWN_TOKEN' };

    const hash = hashSecret(params.token, config().VERIFICATION_SALT);
    const issued = await this.repos.sessionToken.forCall(params.tenantId, params.uccCallId);
    const match = issued.find((t) => safeEqual(t.tokenHash, hash));

    if (!match) {
      // Either we never issued this token, or it was issued for a different call. Both are
      // refusals; we do not confirm which, because that would be an oracle.
      return { ok: false, reason: 'UNKNOWN_TOKEN' };
    }
    if (match.uccCallId !== params.uccCallId) return { ok: false, reason: 'WRONG_CALL' };
    if (match.revokedAt) return { ok: false, reason: 'REVOKED' };
    if (Date.parse(match.expiresAt) <= Date.now()) return { ok: false, reason: 'EXPIRED' };

    return { ok: true };
  }

  /** Invalidate every token for a call. Called when the call ends (FR-029). */
  async revokeForCall(tenantId: string, uccCallId: string): Promise<void> {
    const issued = await this.repos.sessionToken.forCall(tenantId, uccCallId);
    const revokedAt = nowIso();
    await Promise.all(
      issued
        .filter((t) => !t.revokedAt)
        .map((t) => this.repos.sessionToken.put({ ...t, revokedAt })),
    );
  }
}
