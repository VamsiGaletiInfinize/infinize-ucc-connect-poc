import type { ReactNode } from 'react';

/** Shared presentational primitives, so status colour is consistent everywhere. */

export function Panel({
  title,
  actions,
  children,
  flush,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <div className="panel">
      {title && (
        <div className="panel-header">
          <span className="panel-title">{title}</span>
          {actions && <div className="right row">{actions}</div>}
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: 'green' | 'amber' | 'red' | 'accent';
  hint?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` ${tone}` : ''}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

const TICKET_TONE: Record<string, string> = {
  AI_HANDLING: 'purple',
  AI_RESOLVED: 'green',
  ESCALATED: 'amber',
  QUEUED_FOR_AGENT: 'amber',
  AGENT_ASSIGNED: 'blue',
  AGENT_HANDLING: 'blue',
  RESOLVED: 'green',
  CLOSED: 'gray',
  ABANDONED: 'red',
};

export function TicketStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${TICKET_TONE[status] ?? 'gray'}`}>{status.replace(/_/g, ' ')}</span>;
}

const CALL_TONE: Record<string, string> = {
  INITIATED: 'gray',
  AI_HANDLING: 'purple',
  QUEUED: 'amber',
  AGENT_CONNECTED: 'blue',
  ON_HOLD: 'amber',
  COMPLETED: 'gray',
  ABANDONED: 'red',
  FAILED: 'red',
};

export function CallStatusBadge({ status }: { status: string }) {
  return <span className={`badge ${CALL_TONE[status] ?? 'gray'}`}>{status.replace(/_/g, ' ')}</span>;
}

const AGENT_TONE: Record<string, string> = {
  AVAILABLE: 'green',
  ON_CALL: 'blue',
  AFTER_CALL_WORK: 'amber',
  BREAK: 'amber',
  OFFLINE: 'gray',
};

export function AgentStatusBadge({ status }: { status: string }) {
  const dot = { AVAILABLE: 'green', ON_CALL: 'blue', AFTER_CALL_WORK: 'amber', BREAK: 'amber', OFFLINE: 'gray' }[
    status
  ];
  return (
    <span className={`badge ${AGENT_TONE[status] ?? 'gray'}`}>
      <span className={`dot ${dot}`} />
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function VerificationBadge({ status }: { status: string }) {
  const tone =
    status === 'VERIFIED' ? 'green' : status === 'FAILED' ? 'red' : status === 'NOT_REQUIRED' ? 'gray' : 'amber';
  return <span className={`badge ${tone}`}>{status.replace(/_/g, ' ')}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const tone = { LOW: 'gray', NORMAL: 'blue', HIGH: 'amber', URGENT: 'red' }[priority] ?? 'gray';
  return <span className={`badge ${tone}`}>{priority}</span>;
}

/** Explicit, unmissable label for anything that is not real (constitution Principle VII). */
export function MockBadge({ children }: { children: ReactNode }) {
  return (
    <div className="mock-banner">
      <strong>POC MOCK</strong>
      <span>{children}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function relativeTime(iso?: string | null): string {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
