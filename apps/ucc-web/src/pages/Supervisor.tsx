import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, subscribeRealtime } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import {
  CallStatusBadge,
  Empty,
  Panel,
  Stat,
  TicketStatusBadge,
  clockTime,
  relativeTime,
} from '../components/ui.tsx';

/** Supervisor floor view — live calls, queues, agents, escalations, tickets. */
export function Supervisor() {
  const { data, loading, refresh } = usePoll(() => api.supervisor(), 4000);
  const [feed, setFeed] = useState<any[]>([]);

  // Realtime: refresh immediately on any committed event rather than waiting for the poll.
  useEffect(() => {
    const unsubscribe = subscribeRealtime((msg) => {
      if (msg.type === 'EVENT' && msg.event) {
        setFeed((prev) => [msg.event, ...prev].slice(0, 30));
        refresh();
      }
    });
    return unsubscribe;
  }, [refresh]);

  if (loading && !data) return <Empty>Loading supervisor view…</Empty>;
  if (!data) return <Empty>Supervisor data unavailable.</Empty>;

  const m = data.metrics;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <Stat label="Active Calls" value={m.activeCalls} tone="accent" />
        <Stat label="AI Calls" value={m.aiCalls} />
        <Stat label="Agent Calls" value={m.agentCalls} tone="green" />
        <Stat
          label="Waiting Calls"
          value={m.waitingCalls}
          hint={m.ringingCalls ? `${m.ringingCalls} ringing at an agent` : undefined}
          tone={m.waitingCalls ? 'amber' : undefined}
        />
        <Stat label="Available Agents" value={m.availableAgents} tone="green" />
        <Stat label="Busy Agents" value={m.busyAgents} />
        <Stat label="Escalations" value={m.escalations} tone={m.escalations ? 'amber' : undefined} />
        <Stat label="Open Tickets" value={m.openTickets} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <div className="col" style={{ gap: 16 }}>
          <Panel title="Live Floor" flush>
            <table>
              <thead>
                <tr><th>Agent</th><th>Status</th><th>Current Call</th><th>Department</th></tr>
              </thead>
              <tbody>
                {data.agents.map((a: any) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>
                      <span className={`badge ${a.status === 'AVAILABLE' ? 'green' : a.status === 'ON_CALL' ? 'blue' : 'gray'}`}>
                        <span className={`dot ${a.status === 'AVAILABLE' ? 'green' : a.status === 'ON_CALL' ? 'blue' : 'gray'}`} />
                        {a.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="mono tiny">{a.currentTicketNumber ?? '—'}</td>
                    <td className="tiny muted">{a.departments.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Active Calls" flush>
            {data.activeCalls.length === 0 ? (
              <Empty>No active contacts.</Empty>
            ) : (
              <table>
                <thead>
                  <tr><th>Ticket</th><th>Caller</th><th>Dir</th><th>Call</th><th>Case</th><th>Dept</th><th>Started</th></tr>
                </thead>
                <tbody>
                  {data.activeCalls.map((c: any) => (
                    <tr key={c.callId}>
                      <td>
                        {c.ticketId ? (
                          <Link to={`/tickets/${c.ticketId}`} className="mono" style={{ color: 'var(--accent)' }}>
                            {c.ticketNumber}
                          </Link>
                        ) : '—'}
                      </td>
                      <td className="mono tiny">{c.callerId}<div className="tiny dim">{c.callerType}</div></td>
                      <td className="tiny">{c.direction === 'INBOUND' ? '↓' : '↑'}</td>
                      <td><CallStatusBadge status={c.status} /></td>
                      <td>{c.ticketStatus && <TicketStatusBadge status={c.ticketStatus} />}</td>
                      <td className="tiny muted">{c.department ?? '—'}</td>
                      <td className="tiny dim">{relativeTime(c.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Queues" flush>
            <table>
              <thead><tr><th>Department</th><th>Waiting</th><th>Handling</th><th>Available</th><th>On Call</th></tr></thead>
              <tbody>
                {data.queues.map((q: any) => (
                  <tr key={q.departmentId}>
                    <td>{q.name}</td>
                    <td><span className={q.waiting ? 'badge amber' : 'badge gray'}>{q.waiting}</span></td>
                    <td>{q.inProgress}</td>
                    <td><span className={q.agentsAvailable ? 'badge green' : 'badge red'}>{q.agentsAvailable}</span></td>
                    <td>{q.agentsOnCall}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <Panel title="Realtime Event Feed">
          <div className="scroll-box timeline" style={{ maxHeight: 620 }}>
            {feed.length === 0 ? (
              <Empty>Waiting for events…</Empty>
            ) : (
              feed.map((e: any) => (
                <div className={`timeline-item ${e.actor.toLowerCase()}`} key={e.id}>
                  <div className="timeline-type">{e.type}</div>
                  <div className="timeline-meta">{clockTime(e.occurredAt)} · {e.actor}</div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
