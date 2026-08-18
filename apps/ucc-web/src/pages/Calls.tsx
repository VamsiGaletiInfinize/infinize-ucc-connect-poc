import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import {
  CallStatusBadge,
  Empty,
  Panel,
  TicketStatusBadge,
  clockTime,
  duration,
  relativeTime,
} from '../components/ui.tsx';

export function Calls() {
  const { data, loading } = usePoll(() => api.listCalls(), 4000);
  const navigate = useNavigate();

  if (loading && !data) return <Empty>Loading calls…</Empty>;
  const calls = data ?? [];

  return (
    <Panel title={`Calls (${calls.length})`} flush>
      {calls.length === 0 ? (
        <Empty>
          No calls yet. Start one from the <Link to="/live" style={{ color: 'var(--accent)' }}>Live Call Console</Link>.
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Call</th>
              <th>Dir</th>
              <th>Caller</th>
              <th>Type</th>
              <th>Status</th>
              <th>Provider</th>
              <th>Started</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c: any) => (
              <tr key={c.id} className="clickable" onClick={() => navigate(`/calls/${c.id}`)}>
                <td className="mono tiny" style={{ color: 'var(--accent)' }}>
                  {c.id.slice(0, 13)}…
                </td>
                <td className="tiny">{c.direction === 'INBOUND' ? '↓ IN' : '↑ OUT'}</td>
                <td className="mono tiny">{c.callerId}</td>
                <td className="tiny muted">{c.callerType}</td>
                <td>
                  <CallStatusBadge status={c.status} />
                </td>
                <td className="tiny dim">{c.provider === 'AMAZON_CONNECT' ? 'Connect' : 'Simulated'}</td>
                <td className="tiny muted">{clockTime(c.startedAt)}</td>
                <td className="tiny muted">{duration(c.duration)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function CallDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { data, loading } = usePoll(() => api.getCall(id!), 3000);

  if (loading && !data) return <Empty>Loading call…</Empty>;
  if (!data) return <Empty>Call not found.</Empty>;

  const { call, ticket, timeline, transcript } = data;

  return (
    <div className="col" style={{ gap: 16 }}>
      <Panel title="Call">
        <dl className="kv">
          <dt>Call ID</dt>
          <dd className="mono">{call.id}</dd>
          <dt>Provider contact</dt>
          <dd className="mono">{call.providerContactId}</dd>
          <dt>Provider</dt>
          <dd>{call.provider}</dd>
          <dt>Trace ID</dt>
          <dd className="mono">{call.traceId}</dd>
          <dt>Direction</dt>
          <dd>{call.direction}</dd>
          <dt>Caller</dt>
          <dd className="mono">
            {call.callerId} <span className="dim">({call.callerType})</span>
          </dd>
          <dt>Status</dt>
          <dd>
            <CallStatusBadge status={call.status} />
          </dd>
          <dt>Case</dt>
          <dd>
            {ticket ? (
              <Link to={`/tickets/${ticket.id}`} style={{ color: 'var(--accent)' }}>
                {ticket.ticketNumber}
              </Link>
            ) : (
              '—'
            )}
          </dd>
          <dt>Started</dt>
          <dd className="muted">{new Date(call.startedAt).toLocaleString()}</dd>
          <dt>Duration</dt>
          <dd className="muted">{duration(call.duration)}</dd>
        </dl>
      </Panel>

      <div className="grid grid-2">
        <Panel title={`Conversation (${transcript?.turns?.length ?? 0} turns)`}>
          <div className="scroll-box">
            {!transcript || transcript.turns.length === 0 ? (
              <Empty>No conversation recorded.</Empty>
            ) : (
              transcript.turns.map((t: any) => (
                <div className="turn" key={t.id}>
                  <div className={`turn-avatar ${t.speaker.toLowerCase()}`}>
                    {t.speaker === 'CALLER' ? 'C' : t.speaker === 'AI' ? 'AI' : 'AG'}
                  </div>
                  <div className="turn-body">
                    <div className="turn-who">
                      {t.speakerName ?? t.speaker} · {clockTime(t.timestamp)}
                    </div>
                    <div className="turn-text">{t.content}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel title={`Timeline (${timeline.length})`}>
          <div className="scroll-box timeline">
            {timeline.map((e: any) => (
              <div className={`timeline-item ${e.actor.toLowerCase()}`} key={e.id}>
                <div className="timeline-type">{e.type}</div>
                <div className="timeline-meta">
                  {clockTime(e.occurredAt)} · {e.actor}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
