/**
 * Core UCC domain model.
 *
 * Ownership boundary (constitution Principle I):
 *   - Amazon Connect owns telephony, queues, routing profiles, agent presence.
 *   - UCC owns tenant, caller, identity, verification, authorization, case management.
 *
 * These types describe the UCC side. Provider-specific identifiers are always carried
 * in explicit `provider*` fields so the domain never leaks a vendor's shape.
 */

// ---------------------------------------------------------------------------
// Tenancy & identity
// ---------------------------------------------------------------------------

/** A university. Every persisted record is scoped by tenantId. */
export interface Tenant {
  id: string;
  name: string;
  shortName: string;
  timezone: string;
  supportEmail: string;
  supportPhone: string;
  /** Free-form metadata surfaced to the AI as tenant context. */
  metadata: Record<string, string>;
}

export const CALLER_TYPES = [
  'PROSPECT',
  'APPLICANT',
  'STUDENT',
  'PARENT',
  'GUARDIAN',
  'FACULTY',
  'STAFF',
  'ALUMNI',
  'VENDOR',
  'UNKNOWN',
] as const;

export type CallerType = (typeof CALLER_TYPES)[number];

/** Caller types permitted to access protected transactional records they own. */
export const SELF_SERVICE_CALLER_TYPES: readonly CallerType[] = [
  'APPLICANT',
  'STUDENT',
  'ALUMNI',
];

export interface Caller {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  callerType: CallerType;
  /** E.164 phone number used to resolve identity from ANI. */
  phone: string;
  email: string;
  /** Present for APPLICANT / STUDENT / ALUMNI. Links to the university system of record. */
  studentId?: string;
  /**
   * For PARENT / GUARDIAN: student ids this caller is authorised to enquire about.
   * Authorisation is still enforced server-side; this is data, not a grant.
   */
  relatedStudentIds?: string[];
  /** Last 4 of the registered mobile — used as a knowledge factor in verification. */
  dateOfBirth?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export const DEPARTMENT_CODES = [
  'ADMISSIONS',
  'FINANCIAL_AID',
  'TECHNICAL_SUPPORT',
  'GENERAL',
] as const;

export type DepartmentCode = (typeof DEPARTMENT_CODES)[number];

export interface Department {
  id: string;
  tenantId: string;
  code: DepartmentCode;
  name: string;
  description: string;
  /** Amazon Connect queue this department maps to. */
  queueId: string;
  queueName: string;
  /** Provider queue ARN once Connect is provisioned. */
  providerQueueArn?: string;
  slaSeconds: number;
}

export const AGENT_STATUSES = [
  'AVAILABLE',
  'ON_CALL',
  'AFTER_CALL_WORK',
  'BREAK',
  'OFFLINE',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface Agent {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  /** Amazon Connect routing profile controlling which queues this agent serves. */
  routingProfileId: string;
  routingProfileName: string;
  departmentIds: string[];
  status: AgentStatus;
  /** UccCall currently being handled, if any. */
  currentCallId?: string;
  /** Provider user id once Connect is provisioned. */
  providerUserId?: string;
  maxConcurrentContacts: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type CallDirection = 'INBOUND' | 'OUTBOUND';
export type CallChannel = 'VOICE' | 'CHAT';
export type TelephonyProviderName = 'AMAZON_CONNECT' | 'SIMULATED_CONNECT';

export const CALL_STATUSES = [
  'INITIATED',
  'AI_HANDLING',
  'QUEUED',
  'AGENT_CONNECTED',
  'ON_HOLD',
  'COMPLETED',
  'ABANDONED',
  'FAILED',
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

/**
 * The telephony interaction. One UccCall per provider contact.
 *
 * Design note: `providerContactId` is the correlation key into Amazon Connect. It is
 * indexed (GSI2) so any Connect contact can be resolved to its UCC case in one lookup.
 */
export interface UccCall {
  id: string;
  tenantId: string;
  provider: TelephonyProviderName;
  providerContactId: string;
  direction: CallDirection;
  channel: CallChannel;
  /** E.164 number of the far end. */
  callerId: string;
  callerType: CallerType;
  /** Resolved UCC caller, absent when the ANI is unknown. */
  callerRefId?: string;
  status: CallStatus;
  intent?: string;
  departmentId?: string;
  agentId?: string;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  /** Seconds. Computed at call end. */
  duration?: number;
  recordingId?: string;
  transcriptId?: string;
  /** Correlates every log line and event for this contact. */
  traceId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export const TICKET_STATUSES = [
  'AI_HANDLING',
  'AI_RESOLVED',
  'ESCALATED',
  'QUEUED_FOR_AGENT',
  'AGENT_ASSIGNED',
  'AGENT_HANDLING',
  'RESOLVED',
  'CLOSED',
  'ABANDONED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_CATEGORIES = [
  'ADMISSIONS_SUPPORT',
  'APPLICATION_STATUS',
  'DOCUMENT_SUBMISSION',
  'FEES_AND_PAYMENTS',
  'SCHOLARSHIP',
  'FINANCIAL_AID',
  'HOSTEL_AND_CAMPUS',
  'TECHNICAL_SUPPORT',
  'GENERAL_ENQUIRY',
  'DEADLINE_REMINDER',
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export type VerificationStatus =
  | 'NOT_REQUIRED'
  | 'REQUIRED'
  | 'PENDING'
  | 'VERIFIED'
  | 'FAILED';

/**
 * The business case. Created at call start for every contact (constitution Principle II),
 * never only on escalation.
 *
 * A UccTicket is deliberately NOT a copy of UccCall: it carries business classification,
 * verification state, ownership and resolution, and outlives the telephony interaction.
 */
export interface UccTicket {
  id: string;
  /** Human-facing identifier, e.g. UCC-10001. */
  ticketNumber: string;
  tenantId: string;
  uccCallId: string;
  callerId: string;
  callerType: CallerType;
  intent?: string;
  category: TicketCategory;
  priority: TicketPriority;
  departmentId?: string;
  verificationStatus: VerificationStatus;
  status: TicketStatus;
  assignedAgentId?: string;
  summary?: string;
  resolution?: string;
  /** Free-text agent notes, append-only. */
  notes: TicketNote[];
  /** Application ids discussed during the contact, for traceability. */
  relatedApplicationIds: string[];
  traceId: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  closedAt?: string;
}

export interface TicketNote {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const UCC_EVENT_TYPES = [
  'CALL_STARTED',
  'CASE_CREATED',
  'AI_GREETING',
  'INTENT_IDENTIFIED',
  'KB_RETRIEVAL',
  'AI_RESPONSE',
  'VERIFICATION_REQUIRED',
  'OTP_SENT',
  'IDENTITY_VERIFIED',
  'IDENTITY_FAILED',
  'APPLICATION_LOOKUP',
  'APPLICATION_STATUS_RETURNED',
  'ESCALATION_REQUESTED',
  'ROUTING_STARTED',
  'QUEUE_ENTERED',
  'AGENT_ASSIGNED',
  'AGENT_CONNECTED',
  'AGENT_DISCONNECTED',
  'CALLBACK_REQUESTED',
  'CALLBACK_COMPLETED',
  'CALL_ENDED',
  'RECORDING_AVAILABLE',
  'TRANSCRIPT_AVAILABLE',
  'TICKET_RESOLVED',
  'TICKET_CLOSED',
] as const;

export type UccEventType = (typeof UCC_EVENT_TYPES)[number];

/**
 * Append-only timeline entry.
 *
 * `idempotencyKey` is deterministic (see services/events). Providers deliver at-least-once;
 * a duplicate delivery must be a no-op (constitution Principle VI).
 */
export interface UccEvent {
  id: string;
  tenantId: string;
  uccCallId: string;
  uccTicketId?: string;
  type: UccEventType;
  /** Deterministic dedupe key. Conditional-write guarded at the repository. */
  idempotencyKey: string;
  /** Event-specific detail. Must never contain OTP values or secrets. */
  payload: Record<string, unknown>;
  /** Who caused it: the AI, an agent, the provider, or the system. */
  actor: 'AI' | 'AGENT' | 'CALLER' | 'SYSTEM' | 'PROVIDER';
  actorId?: string;
  traceId: string;
  occurredAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * A verification attempt bound to a single call.
 *
 * The OTP itself is never persisted in plaintext and never logged. For the POC the
 * expected value is fixed (DEMO ONLY) but the surrounding lifecycle — expiry, attempt
 * limits, single-use, call binding — is production-shaped.
 */
export interface VerificationSession {
  id: string;
  tenantId: string;
  uccCallId: string;
  callerId: string;
  /** Salted hash of the expected OTP. Never the OTP itself. */
  otpHash: string;
  status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'EXPIRED';
  attempts: number;
  maxAttempts: number;
  /** Channel the OTP was notionally delivered over. */
  deliveryChannel: 'SMS' | 'EMAIL';
  /** Masked destination for display, e.g. +91 ****** 4821. */
  maskedDestination: string;
  expiresAt: string;
  verifiedAt?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Applications (university system of record)
// ---------------------------------------------------------------------------

export const APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'DOCUMENTS_PENDING',
  'INTERVIEW_SCHEDULED',
  'ADMITTED',
  'WAITLISTED',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface ApplicationDocument {
  name: string;
  status: 'RECEIVED' | 'PENDING' | 'REJECTED';
  receivedAt?: string;
  note?: string;
}

/**
 * Protected transactional record. Authoritative source is the university API —
 * never RAG (constitution Principle IV).
 */
export interface Application {
  id: string;
  tenantId: string;
  applicationId: string;
  studentId: string;
  program: string;
  programLevel: 'UNDERGRADUATE' | 'POSTGRADUATE' | 'DOCTORAL';
  term: string;
  status: ApplicationStatus;
  submittedAt?: string;
  lastUpdatedAt: string;
  decisionDate?: string;
  documents: ApplicationDocument[];
  /** Outstanding fee in INR, if any. */
  outstandingFee?: number;
  scholarshipApplied: boolean;
  scholarshipStatus?: 'NOT_APPLIED' | 'UNDER_REVIEW' | 'AWARDED' | 'DECLINED';
  notes?: string;
}

// ---------------------------------------------------------------------------
// Recording & transcript
// ---------------------------------------------------------------------------

export interface Recording {
  id: string;
  tenantId: string;
  uccCallId: string;
  provider: TelephonyProviderName;
  providerContactId: string;
  /** s3://bucket/key — the binary never lands in DynamoDB. */
  storageLocation: string;
  /** Seconds. */
  duration: number;
  format: 'wav' | 'mp3';
  sizeBytes?: number;
  retentionPolicy: string;
  createdAt: string;
}

export type TranscriptSpeaker = 'CALLER' | 'AI' | 'AGENT' | 'SYSTEM';
export type TranscriptSegmentKind = 'AI_CONVERSATION' | 'AGENT_CONVERSATION';

export interface TranscriptTurn {
  id: string;
  speaker: TranscriptSpeaker;
  speakerName?: string;
  kind: TranscriptSegmentKind;
  content: string;
  /** Milliseconds from call start. */
  offsetMs: number;
  timestamp: string;
}

/** Normalized UCC conversation representation covering both AI and agent segments. */
export interface Transcript {
  id: string;
  tenantId: string;
  uccCallId: string;
  uccTicketId: string;
  provider: TelephonyProviderName;
  providerContactId: string;
  turns: TranscriptTurn[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Callback & outbound
// ---------------------------------------------------------------------------

export type CallbackStatus = 'REQUESTED' | 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Callback {
  id: string;
  tenantId: string;
  uccCallId: string;
  uccTicketId: string;
  callerId: string;
  phone: string;
  departmentId: string;
  status: CallbackStatus;
  requestedAt: string;
  scheduledFor: string;
  /** UccCall created when the callback is actually dialled. */
  callbackCallId?: string;
  completedAt?: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

export type CampaignStatus = 'DRAFT' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface OutboundCampaign {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  category: TicketCategory;
  departmentId: string;
  status: CampaignStatus;
  targetCallerIds: string[];
  /** UccCall ids produced by this campaign. */
  callIds: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export interface KnowledgeChunk {
  id: string;
  tenantId: string;
  documentId: string;
  title: string;
  category: string;
  content: string;
  /** Titan Text Embeddings v2 vector. */
  embedding: number[];
  sourceUri: string;
}

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  title: string;
  category: string;
  content: string;
  score: number;
  sourceUri: string;
}
