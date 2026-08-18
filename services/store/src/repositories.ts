import type {
  Agent,
  Application,
  Callback,
  Caller,
  Department,
  OutboundCampaign,
  Recording,
  Tenant,
  Transcript,
  UccCall,
  UccEvent,
  UccTicket,
  VerificationSession,
} from '@ucc/types';
import { COLLECTIONS, type DocumentStore } from './document-store.ts';

/**
 * Typed repositories over the tenant-scoped document store.
 *
 * Every method takes tenantId explicitly. There is no ambient tenant and no default —
 * forgetting the tenant is a compile error rather than a data leak.
 */
export class Repositories {
  constructor(private readonly store: DocumentStore) {}

  // --- tenants & org ------------------------------------------------------

  tenant = {
    put: (t: Tenant) => this.store.put(COLLECTIONS.tenant, t.id, t.id, t),
    get: (tenantId: string) => this.store.get<Tenant>(COLLECTIONS.tenant, tenantId, tenantId),
  };

  department = {
    put: (d: Department) => this.store.put(COLLECTIONS.department, d.tenantId, d.id, d),
    get: (tenantId: string, id: string) =>
      this.store.get<Department>(COLLECTIONS.department, tenantId, id),
    list: (tenantId: string) => this.store.list<Department>(COLLECTIONS.department, tenantId),
    byCode: async (tenantId: string, code: Department['code']) => {
      const all = await this.store.list<Department>(COLLECTIONS.department, tenantId);
      return all.find((d) => d.code === code) ?? null;
    },
  };

  agent = {
    put: (a: Agent) => this.store.put(COLLECTIONS.agent, a.tenantId, a.id, a),
    get: (tenantId: string, id: string) => this.store.get<Agent>(COLLECTIONS.agent, tenantId, id),
    list: (tenantId: string) => this.store.list<Agent>(COLLECTIONS.agent, tenantId),
  };

  // --- people & records ---------------------------------------------------

  caller = {
    put: (c: Caller) => this.store.put(COLLECTIONS.caller, c.tenantId, c.id, c),
    get: (tenantId: string, id: string) => this.store.get<Caller>(COLLECTIONS.caller, tenantId, id),
    list: (tenantId: string) => this.store.list<Caller>(COLLECTIONS.caller, tenantId),
    /** Resolve identity from ANI. Returns null when the number is not recognised. */
    byPhone: async (tenantId: string, phone: string) => {
      const all = await this.store.list<Caller>(COLLECTIONS.caller, tenantId);
      return all.find((c) => c.phone === phone) ?? null;
    },
  };

  application = {
    put: (a: Application) => this.store.put(COLLECTIONS.application, a.tenantId, a.id, a),
    get: (tenantId: string, id: string) =>
      this.store.get<Application>(COLLECTIONS.application, tenantId, id),
    list: (tenantId: string) => this.store.list<Application>(COLLECTIONS.application, tenantId),
    /** All applications belonging to one student, within one tenant. */
    byStudent: async (tenantId: string, studentId: string) => {
      const all = await this.store.list<Application>(COLLECTIONS.application, tenantId);
      return all.filter((a) => a.studentId === studentId);
    },
    byApplicationId: async (tenantId: string, applicationId: string) => {
      const all = await this.store.list<Application>(COLLECTIONS.application, tenantId);
      return all.find((a) => a.applicationId === applicationId) ?? null;
    },
  };

  // --- contact centre -----------------------------------------------------

  call = {
    put: async (c: UccCall) => {
      await this.store.put(COLLECTIONS.call, c.tenantId, c.id, c);
      await this.store.put(COLLECTIONS.callByContact, c.tenantId, c.providerContactId, {
        uccCallId: c.id,
      });
    },
    get: (tenantId: string, id: string) => this.store.get<UccCall>(COLLECTIONS.call, tenantId, id),
    list: (tenantId: string) => this.store.list<UccCall>(COLLECTIONS.call, tenantId),
    /** One-read correlation from an Amazon Connect contact id to the UCC case. */
    byProviderContactId: async (tenantId: string, providerContactId: string) => {
      const pointer = await this.store.get<{ uccCallId: string }>(
        COLLECTIONS.callByContact,
        tenantId,
        providerContactId,
      );
      if (!pointer) return null;
      return this.store.get<UccCall>(COLLECTIONS.call, tenantId, pointer.uccCallId);
    },
  };

  ticket = {
    put: (t: UccTicket) => this.store.put(COLLECTIONS.ticket, t.tenantId, t.id, t),
    get: (tenantId: string, id: string) =>
      this.store.get<UccTicket>(COLLECTIONS.ticket, tenantId, id),
    list: (tenantId: string) => this.store.list<UccTicket>(COLLECTIONS.ticket, tenantId),
    byCallId: async (tenantId: string, uccCallId: string) => {
      const all = await this.store.list<UccTicket>(COLLECTIONS.ticket, tenantId);
      return all.find((t) => t.uccCallId === uccCallId) ?? null;
    },
    byNumber: async (tenantId: string, ticketNumber: string) => {
      const all = await this.store.list<UccTicket>(COLLECTIONS.ticket, tenantId);
      return all.find((t) => t.ticketNumber === ticketNumber) ?? null;
    },
  };

  event = {
    /**
     * Append an event, guarded by its deterministic idempotency key.
     * Returns false when this occurrence was already recorded.
     */
    append: async (e: UccEvent): Promise<boolean> => {
      const claimed = await this.store.putIfAbsent(
        COLLECTIONS.eventIdempotency,
        e.tenantId,
        e.idempotencyKey,
        { eventId: e.id },
      );
      if (!claimed) return false;
      await this.store.put(COLLECTIONS.event, e.tenantId, e.id, e);
      return true;
    },
    list: (tenantId: string) => this.store.list<UccEvent>(COLLECTIONS.event, tenantId),
    byCallId: async (tenantId: string, uccCallId: string) => {
      const all = await this.store.list<UccEvent>(COLLECTIONS.event, tenantId);
      return all
        .filter((e) => e.uccCallId === uccCallId)
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    },
    byTicketId: async (tenantId: string, uccTicketId: string) => {
      const all = await this.store.list<UccEvent>(COLLECTIONS.event, tenantId);
      return all
        .filter((e) => e.uccTicketId === uccTicketId)
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    },
  };

  verification = {
    put: (v: VerificationSession) =>
      this.store.put(COLLECTIONS.verification, v.tenantId, v.id, v),
    get: (tenantId: string, id: string) =>
      this.store.get<VerificationSession>(COLLECTIONS.verification, tenantId, id),
    list: (tenantId: string) =>
      this.store.list<VerificationSession>(COLLECTIONS.verification, tenantId),
    /** The active session for a call, if any. */
    activeForCall: async (tenantId: string, uccCallId: string) => {
      const all = await this.store.list<VerificationSession>(COLLECTIONS.verification, tenantId);
      return (
        all
          .filter((v) => v.uccCallId === uccCallId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
      );
    },
    /** Any successful verification for this call — the sole basis for `verified`. */
    verifiedForCall: async (tenantId: string, uccCallId: string) => {
      const all = await this.store.list<VerificationSession>(COLLECTIONS.verification, tenantId);
      return all.find((v) => v.uccCallId === uccCallId && v.status === 'VERIFIED') ?? null;
    },
  };

  recording = {
    put: (r: Recording) => this.store.put(COLLECTIONS.recording, r.tenantId, r.id, r),
    get: (tenantId: string, id: string) =>
      this.store.get<Recording>(COLLECTIONS.recording, tenantId, id),
    list: (tenantId: string) => this.store.list<Recording>(COLLECTIONS.recording, tenantId),
  };

  transcript = {
    put: (t: Transcript) => this.store.put(COLLECTIONS.transcript, t.tenantId, t.id, t),
    get: (tenantId: string, id: string) =>
      this.store.get<Transcript>(COLLECTIONS.transcript, tenantId, id),
    byCallId: async (tenantId: string, uccCallId: string) => {
      const all = await this.store.list<Transcript>(COLLECTIONS.transcript, tenantId);
      return all.find((t) => t.uccCallId === uccCallId) ?? null;
    },
  };

  callback = {
    put: (c: Callback) => this.store.put(COLLECTIONS.callback, c.tenantId, c.id, c),
    get: (tenantId: string, id: string) =>
      this.store.get<Callback>(COLLECTIONS.callback, tenantId, id),
    list: (tenantId: string) => this.store.list<Callback>(COLLECTIONS.callback, tenantId),
  };

  campaign = {
    put: (c: OutboundCampaign) => this.store.put(COLLECTIONS.campaign, c.tenantId, c.id, c),
    get: (tenantId: string, id: string) =>
      this.store.get<OutboundCampaign>(COLLECTIONS.campaign, tenantId, id),
    list: (tenantId: string) =>
      this.store.list<OutboundCampaign>(COLLECTIONS.campaign, tenantId),
  };

  /** AI conversation state, keyed by call. Not exposed to the frontend directly. */
  conversation = {
    put: (tenantId: string, uccCallId: string, value: object) =>
      this.store.put(COLLECTIONS.conversation, tenantId, uccCallId, value),
    get: <T>(tenantId: string, uccCallId: string) =>
      this.store.get<T>(COLLECTIONS.conversation, tenantId, uccCallId),
  };
}
