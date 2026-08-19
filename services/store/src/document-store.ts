/**
 * Tenant-scoped document store.
 *
 * SECURITY (constitution Principle III / FR-010): tenantId is part of the partition key,
 * not a filter applied after reading. A caller that supplies the wrong tenant cannot read
 * another tenant's item because the key it would need does not exist. Cross-tenant
 * isolation is therefore structural rather than a check somebody can forget to write.
 */
export interface DocumentStore {
  get<T>(collection: string, tenantId: string, id: string): Promise<T | null>;

  put<T extends object>(collection: string, tenantId: string, id: string, item: T): Promise<void>;

  /**
   * Write only if no item exists at this key.
   * Returns false when the item already existed — the basis of event idempotency.
   */
  putIfAbsent<T extends object>(
    collection: string,
    tenantId: string,
    id: string,
    item: T,
  ): Promise<boolean>;

  list<T>(collection: string, tenantId: string): Promise<T[]>;

  delete(collection: string, tenantId: string, id: string): Promise<void>;
}

/** Logical collections. Kept as constants so key construction is never ad hoc. */
export const COLLECTIONS = {
  tenant: 'tenant',
  department: 'department',
  agent: 'agent',
  caller: 'caller',
  application: 'application',
  call: 'call',
  ticket: 'ticket',
  event: 'event',
  /** providerContactId -> { uccCallId }, so a Connect contact resolves in one read. */
  callByContact: 'call-by-contact',
  /** idempotencyKey -> { eventId }, guarding duplicate provider deliveries. */
  eventIdempotency: 'event-idempotency',
  verification: 'verification',
  recording: 'recording',
  transcript: 'transcript',
  callback: 'callback',
  campaign: 'campaign',
  conversation: 'conversation',
  /** Per-call bearer binding a voice stream to one case. */
  sessionToken: 'session-token',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
