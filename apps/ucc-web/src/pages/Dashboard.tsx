import { Link } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import {
  CallStatusBadge,
  Empty,
  Panel,
  Stat,
  TicketStatusBadge,
  relativeTime,
} from '../components/ui.tsx';

export function Dashboard() {
  const { data, loading } = usePoll(() => api.supervisor(), 4000);

  if (loading && !data) return <Empty>Loading operations data…</Empty>;
  if (!data) return <Empty>Operations data unavailable.</Empty>;

  const m = data.metrics;
  const containment =
    m.aiResolved + m.escalations > 0
      ? Math.round((m.aiResolved / (m.aiResolved + m.escalations)) * 100)
      : 0;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid grid-4">
        <Stat label="Active Calls" value={m.activeCalls} tone="accent" />
        <Stat label="AI Handling" value={m.aiCalls} hint="No human involved" />
        <Stat label="Agent Calls" value={m.agentCalls} tone="green" />
        <Stat
          label="Waiting in Queue"
          value={m.waitingCalls}
          hint={m.ringingCalls ? `${m.ringingCalls} ringing at an agent` : undefined}
          tone={m.waitingCalls > 0 ? 'amber' : undefined}
        />
      </div>

      <div className="grid grid-4">
        <Stat label="Available Agents" value={m.availableAgents} tone="green" />
        <Stat label="Busy Agents" value={m.busyAgents} />
        <Stat label="Open Tickets" value={m.openTickets} />
        <Stat
          label="AI Containment"
          value={`${containment}%`}
          tone={containment >= 50 ? 'green' : 'amber'}
          hint={`${m.aiResolved} AI-resolved · ${m.escalations} escalated`}
        />
      </div>

      <div className="grid grid-2">
        <Panel title="Active Contacts" flush>
          {data.activeCalls.length === 0 ? (
            <Empty>No active contacts.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Caller</th>
                  <th>Dir</th>
                  <th>Call</th>
                  <th>Case</th>
                  <th>Dept</th>
                </tr>
              </thead>
              <tbody>
                {data.activeCalls.map((c: any) => (
                  <tr key={c.callId}>
                    <td>
                      {c.ticketId ? (
                        <Link to={`/tickets/${c.ticketId}`} className="mono" style={{ color: 'var(--accent)' }}>
                          {c.ticketNumber}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <div className="mono tiny">{c.callerId}</div>
                      <div className="tiny dim">{c.callerType}</div>
                    </td>
                    <td className="tiny">{c.direction === 'INBOUND' ? '↓ IN' : '↑ OUT'}</td>
                    <td>
                      <CallStatusBadge status={c.status} />
                    </td>
                    <td>{c.ticketStatus && <TicketStatusBadge status={c.ticketStatus} />}</td>
                    <td className="tiny muted">{c.department ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Queues" flush>
          <table>
            <thead>
              <tr>
                <th>Department</th>
                <th>Waiting</th>
                <th>Handling</th>
                <th>Available</th>
              </tr>
            </thead>
            <tbody>
              {data.queues.map((q: any) => (
                <tr key={q.departmentId}>
                  <td>
                    <div>{q.name}</div>
                    <div className="tiny dim mono">{q.queueName}</div>
                  </td>
                  <td>
                    <span className={q.waiting > 0 ? 'badge amber' : 'badge gray'}>{q.waiting}</span>
                  </td>
                  <td>{q.inProgress}</td>
                  <td>
                    <span className={q.agentsAvailable > 0 ? 'badge green' : 'badge red'}>
                      {q.agentsAvailable}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Agent Floor" flush>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Routing Profile</th>
              <th>Departments</th>
              <th>Current Case</th>
            </tr>
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
                <td className="tiny muted">{a.routingProfile}</td>
                <td className="tiny muted">{a.departments.join(', ')}</td>
                <td className="mono tiny">{a.currentTicketNumber ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
