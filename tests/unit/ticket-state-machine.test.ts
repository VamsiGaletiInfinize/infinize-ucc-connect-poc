import { describe, expect, it } from 'vitest';
import {
  InvalidTicketTransitionError,
  OPEN_TICKET_STATUSES,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  assertTransition,
  canTransition,
  isTerminal,
  type TicketStatus,
} from '@ucc/types';

describe('ticket state machine', () => {
  it('permits the documented happy path to AI resolution', () => {
    expect(canTransition('AI_HANDLING', 'AI_RESOLVED')).toBe(true);
    expect(canTransition('AI_RESOLVED', 'CLOSED')).toBe(true);
  });

  it('permits the documented escalation path end to end', () => {
    const path: TicketStatus[] = [
      'AI_HANDLING',
      'ESCALATED',
      'QUEUED_FOR_AGENT',
      'AGENT_ASSIGNED',
      'AGENT_HANDLING',
      'RESOLVED',
      'CLOSED',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('rejects skipping the queue straight to agent handling', () => {
    expect(canTransition('AI_HANDLING', 'AGENT_HANDLING')).toBe(false);
    expect(() => assertTransition('AI_HANDLING', 'AGENT_HANDLING')).toThrow(
      InvalidTicketTransitionError,
    );
  });

  it('rejects resolving a case that never reached an agent', () => {
    expect(canTransition('AI_HANDLING', 'RESOLVED')).toBe(false);
    expect(canTransition('QUEUED_FOR_AGENT', 'RESOLVED')).toBe(false);
  });

  it('rejects reopening a closed case', () => {
    expect(isTerminal('CLOSED')).toBe(true);
    expect(TICKET_TRANSITIONS.CLOSED).toHaveLength(0);
    for (const status of TICKET_STATUSES) {
      expect(canTransition('CLOSED', status), `CLOSED -> ${status}`).toBe(false);
    }
  });

  it('allows a resolved case to be reopened to agent handling', () => {
    // A supervisor reopening a case is legitimate; reopening a CLOSED one is not.
    expect(canTransition('RESOLVED', 'AGENT_HANDLING')).toBe(true);
  });

  it('allows abandonment from every non-terminal in-flight state', () => {
    for (const status of ['AI_HANDLING', 'ESCALATED', 'QUEUED_FOR_AGENT', 'AGENT_ASSIGNED', 'AGENT_HANDLING'] as TicketStatus[]) {
      expect(canTransition(status, 'ABANDONED'), `${status} -> ABANDONED`).toBe(true);
    }
  });

  it('defines a transition list for every declared status', () => {
    for (const status of TICKET_STATUSES) {
      expect(TICKET_TRANSITIONS[status], status).toBeDefined();
    }
  });

  it('never lists a terminal status as open', () => {
    expect(OPEN_TICKET_STATUSES).not.toContain('CLOSED');
    expect(OPEN_TICKET_STATUSES).not.toContain('AI_RESOLVED');
    expect(OPEN_TICKET_STATUSES).not.toContain('ABANDONED');
  });

  it('reports the allowed set in the error message', () => {
    try {
      assertTransition('QUEUED_FOR_AGENT', 'CLOSED');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTicketTransitionError);
      expect((error as Error).message).toContain('AGENT_ASSIGNED');
    }
  });
});
