import type { TicketStatus } from './domain.ts';

/**
 * Explicit ticket lifecycle.
 *
 *   AI_HANDLING ──┬─▶ AI_RESOLVED ──▶ CLOSED
 *                 │
 *                 └─▶ ESCALATED ──▶ QUEUED_FOR_AGENT ──▶ AGENT_ASSIGNED
 *                                          │                    │
 *                                          │                    ▼
 *                                          │             AGENT_HANDLING ──▶ RESOLVED ──▶ CLOSED
 *                                          │
 *                                          └─▶ ABANDONED (caller hung up while waiting)
 *
 * Any transition not listed here is rejected. The frontend cannot set status directly
 * (constitution Principle VII / FR-003); it may only invoke intent-revealing operations
 * such as `accept` or `resolve`, which the backend maps onto a guarded transition.
 */
export const TICKET_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> =
  Object.freeze({
    AI_HANDLING: ['AI_RESOLVED', 'ESCALATED', 'ABANDONED'],
    AI_RESOLVED: ['CLOSED', 'ESCALATED'],
    ESCALATED: ['QUEUED_FOR_AGENT', 'ABANDONED'],
    QUEUED_FOR_AGENT: ['AGENT_ASSIGNED', 'ABANDONED'],
    AGENT_ASSIGNED: ['AGENT_HANDLING', 'QUEUED_FOR_AGENT', 'ABANDONED'],
    AGENT_HANDLING: ['RESOLVED', 'ESCALATED', 'ABANDONED'],
    RESOLVED: ['CLOSED', 'AGENT_HANDLING'],
    CLOSED: [],
    ABANDONED: ['CLOSED'],
  });

/** Terminal states. No further transitions are permitted out of CLOSED. */
export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ['CLOSED'];

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export class InvalidTicketTransitionError extends Error {
  readonly code = 'INVALID_TICKET_TRANSITION';
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
  ) {
    super(
      `Invalid ticket transition ${from} -> ${to}. Allowed from ${from}: ` +
        `${TICKET_TRANSITIONS[from].join(', ') || '(terminal)'}`,
    );
    this.name = 'InvalidTicketTransitionError';
  }
}

/** Throws unless the transition is explicitly permitted. */
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTicketTransitionError(from, to);
  }
}

/** True once the case is no longer actionable. */
export function isTerminal(status: TicketStatus): boolean {
  return TERMINAL_TICKET_STATUSES.includes(status);
}

/** Statuses counted as "open" on the supervisor dashboard. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'AI_HANDLING',
  'ESCALATED',
  'QUEUED_FOR_AGENT',
  'AGENT_ASSIGNED',
  'AGENT_HANDLING',
];
