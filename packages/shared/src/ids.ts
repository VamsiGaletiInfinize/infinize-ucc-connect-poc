import { createHash, randomUUID, randomBytes } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

export const newTraceId = (): string => randomBytes(16).toString('hex');

export const nowIso = (): string => new Date().toISOString();

/**
 * Deterministic idempotency key for a call event.
 *
 * Providers deliver at-least-once. Two deliveries describing the same occurrence produce
 * the same key, so the conditional write at the repository turns the duplicate into a
 * no-op (constitution Principle VI).
 *
 * `discriminator` distinguishes legitimately repeated event types on one call — e.g. two
 * separate AI_RESPONSE events — and is normally the provider's own event id or a
 * monotonic sequence supplied by the emitter.
 */
export function eventIdempotencyKey(
  uccCallId: string,
  type: string,
  discriminator: string,
): string {
  return createHash('sha256')
    .update(`${uccCallId}::${type}::${discriminator}`)
    .digest('hex');
}

/** Salted hash used so an OTP is never persisted in plaintext. */
export function hashSecret(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}::${value}`).digest('hex');
}

/** Constant-time comparison to avoid leaking match position via timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** +919876543210 -> +91 ****** 3210, for display in UI and prompts. */
export function maskPhone(phone: string): string {
  if (phone.length < 6) return '*'.repeat(phone.length);
  return `${phone.slice(0, 3)} ${'*'.repeat(Math.max(phone.length - 7, 0))} ${phone.slice(-4)}`;
}

let ticketCounter = 10_000;

/** Human-facing ticket number, e.g. UCC-10001. */
export function nextTicketNumber(): string {
  ticketCounter += 1;
  return `UCC-${ticketCounter}`;
}

/** Test seam so ticket numbers are deterministic across runs. */
export function resetTicketCounter(value = 10_000): void {
  ticketCounter = value;
}
