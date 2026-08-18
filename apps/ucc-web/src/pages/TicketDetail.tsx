import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import {
  Empty,
  MockBadge,
  Panel,
  PriorityBadge,
  TicketStatusBadge,
  VerificationBadge,
  clockTime,
  duration,
} from '../components/ui.tsx';

const TABS = [
  'Overview',
  'Conversation',
  'Timeline',
  'Transcript',
  'Recording',
  'Caller',
  'Application',
  'Resolution',
  'Audit',
] as const;

export function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, refresh } = usePoll(() => api.getTicket(id!), 3000);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading && !data) return <Empty>Loading case…</Empty>;
  if (!data) return <Empty>Case not found.</Empty>;

  const { ticket, call, department, caller, agent, timeline, transcript, recording, recordingAvailable, recordingPlannedLocation, applications } = data;

  const actingAgentId = ticket.assignedAgentId ?? 'agent-aditya';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* header */}
      <div className="panel">
        <div className="panel-body">
          <div className="row" style={{ marginBottom: 12 }}>
            <div>
              <div className="row" style={{ gap: 10 }}>
                <span className="mono" style={{ fontSize: 20, fontWeight: 650 }}>
                  {ticket.ticketNumber}
                </span>
                <TicketStatusBadge status={ticket.status} />
                <PriorityBadge priority={ticket.priority} />
                <VerificationBadge status={ticket.verificationStatus} />
              </div>
              <div className="tiny dim" style={{ marginTop: 4 }}>
                Opened {new Date(ticket.createdAt).toLocaleString()} · trace{' '}
                <span className="mono">{ticket.traceId?.slice(0, 16)}…</span>
              </div>
            </div>
            <div className="right row">
              {ticket.status === 'AGENT_ASSIGNED' && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => act(() => api.acceptTicket(ticket.id, actingAgentId))}
                >
                  Accept
                </button>
              )}
              {ticket.status === 'AGENT_HANDLING' && (
                <button
                  className="success"
                  disabled={busy || !resolution.trim()}
                  onClick={() => act(() => api.resolveTicket(ticket.id, actingAgentId, resolution))}
                  title={resolution.trim() ? '' : 'Enter a resolution on the Resolution tab first'}
                >
                  Resolve
                </button>
              )}
              {(ticket.status === 'RESOLVED' || ticket.status === 'AI_RESOLVED') && (
                <button disabled={busy} onClick={() => act(() => api.closeTicket(ticket.id, actingAgentId))}>
                  Close
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-4" style={{ gap: 10 }}>
            <Field label="Caller" value={caller ? `${caller.firstName} ${caller.lastName}` : ticket.callerId} />
            <Field label="Type" value={ticket.callerType} />
            <Field label="Intent" value={ticket.intent ?? '—'} />
            <Field label="Department" value={department?.name ?? '—'} />
            <Field label="Category" value={ticket.category.replace(/_/g, ' ')} />
            <Field label="Agent" value={agent ? `${agent.firstName} ${agent.lastName}` : 'Unassigned'} />
            <Field label="Call" value={call ? <Link to={`/calls/${call.id}`} style={{ color: 'var(--accent)' }}>{call.direction}</Link> : '—'} />
            <Field label="Duration" value={duration(call?.duration)} />
          </div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="tabs">
          {TABS.map((t) => (
            <div key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t}
            </div>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'Overview' && (
            <div className="col">
              <dl className="kv">
                <dt>Ticket ID</dt><dd className="mono">{ticket.id}</dd>
                <dt>UccCall ID</dt><dd className="mono">{ticket.uccCallId}</dd>
                <dt>Provider contact</dt><dd className="mono">{call?.providerContactId ?? '—'}</dd>
                <dt>Provider</dt><dd>{call?.provider ?? '—'}</dd>
                <dt>Trace ID</dt><dd className="mono">{ticket.traceId}</dd>
                <dt>Summary</dt><dd>{ticket.summary ?? <span className="dim">Not set</span>}</dd>
                <dt>Applications</dt>
                <dd>{ticket.relatedApplicationIds?.length ? ticket.relatedApplicationIds.join(', ') : <span className="dim">None linked</span>}</dd>
              </dl>
            </div>
          )}

          {tab === 'Conversation' && <Conversation transcript={transcript} kind="AI_CONVERSATION" />}

          {tab === 'Timeline' && (
            <div className="timeline">
              {timeline.map((e: any) => (
                <div className={`timeline-item ${e.actor.toLowerCase()}`} key={e.id}>
                  <div className="timeline-type">{e.type}</div>
                  <div className="timeline-meta">
                    {new Date(e.occurredAt).toLocaleTimeString()} · {e.actor}
                    {e.actorId ? ` · ${e.actorId}` : ''}
                  </div>
                  {Object.keys(e.payload ?? {}).length > 0 && (
                    <div className="timeline-payload">{JSON.stringify(e.payload)}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'Transcript' && <Conversation transcript={transcript} />}

          {tab === 'Recording' && (
            <div className="col">
              {recordingAvailable && recording ? (
                <dl className="kv">
                  <dt>Recording ID</dt><dd className="mono">{recording.id}</dd>
                  <dt>Storage</dt><dd className="mono">{recording.storageLocation}</dd>
                  <dt>Duration</dt><dd>{duration(recording.duration)}</dd>
                  <dt>Format</dt><dd>{recording.format}</dd>
                  <dt>Retention</dt><dd>{recording.retentionPolicy}</dd>
                </dl>
              ) : (
                <>
                  <MockBadge>
                    No audio recording exists for this contact. Call recording is an Amazon Connect
                    capability and requires a live Connect instance, which this AWS account blocks at
                    the organisation level (see ADR-0004). UCC stores recording metadata only —
                    binaries never enter DynamoDB.
                  </MockBadge>
                  <div className="spacer" />
                  <dl className="kv">
                    <dt>Would be stored at</dt>
                    <dd className="mono">{recordingPlannedLocation ?? '—'}</dd>
                    <dt>Retention policy</dt>
                    <dd>RETAIN_90_DAYS_THEN_DELETE</dd>
                  </dl>
                </>
              )}
            </div>
          )}

          {tab === 'Caller' && (
            <dl className="kv">
              <dt>Name</dt><dd>{caller ? `${caller.firstName} ${caller.lastName}` : 'Not identified'}</dd>
              <dt>Caller type</dt><dd>{ticket.callerType}</dd>
              <dt>Phone</dt><dd className="mono">{caller?.phone ?? call?.callerId}</dd>
              <dt>Email</dt><dd className="mono">{caller?.email ?? '—'}</dd>
              <dt>Student ID</dt><dd className="mono">{caller?.studentId ?? '—'}</dd>
              <dt>Verification</dt><dd><VerificationBadge status={ticket.verificationStatus} /></dd>
            </dl>
          )}

          {tab === 'Application' && (
            applications.length === 0 ? (
              <Empty>No application records for this caller.</Empty>
            ) : (
              <table>
                <thead>
                  <tr><th>Application</th><th>Programme</th><th>Term</th><th>Status</th><th>Outstanding</th><th>Scholarship</th></tr>
                </thead>
                <tbody>
                  {applications.map((a: any) => (
                    <tr key={a.applicationId}>
                      <td className="mono">{a.applicationId}</td>
                      <td>{a.program}</td>
                      <td className="tiny muted">{a.term}</td>
                      <td><span className="badge blue">{a.status.replace(/_/g, ' ')}</span></td>
                      <td className="mono tiny">{a.outstandingFee ? `₹${a.outstandingFee.toLocaleString('en-IN')}` : '—'}</td>
                      <td className="tiny muted">{a.scholarshipStatus?.replace(/_/g, ' ') ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === 'Resolution' && (
            <div className="col">
              {ticket.resolution ? (
                <div className="ok-banner">{ticket.resolution}</div>
              ) : (
                <>
                  <label>Resolution summary</label>
                  <textarea
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    placeholder="Describe how the case was resolved…"
                  />
                  <div className="row">
                    <button
                      className="success"
                      disabled={busy || !resolution.trim() || ticket.status !== 'AGENT_HANDLING'}
                      onClick={() => act(() => api.resolveTicket(ticket.id, actingAgentId, resolution))}
                    >
                      Resolve case
                    </button>
                    {ticket.status !== 'AGENT_HANDLING' && (
                      <span className="tiny dim">
                        Case must be in AGENT_HANDLING to resolve (current: {ticket.status}).
                      </span>
                    )}
                  </div>
                </>
              )}

              <div className="spacer" />
              <label>Agent notes ({ticket.notes.length})</label>
              {ticket.notes.map((n: any) => (
                <div key={n.id} style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 10, marginBottom: 8 }}>
                  <div className="tiny dim">{n.authorName} · {clockTime(n.createdAt)}</div>
                  <div className="small">{n.body}</div>
                </div>
              ))}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" />
              <div className="row">
                <button
                  disabled={busy || !note.trim()}
                  onClick={() => act(async () => { await api.addNote(ticket.id, actingAgentId, note); setNote(''); })}
                >
                  Add note
                </button>
              </div>
            </div>
          )}

          {tab === 'Audit' && (
            <div className="col">
              <div className="tiny dim">
                Every state change is derived from the append-only event timeline. Nothing here is
                editable — this is the audit record.
              </div>
              <table>
                <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Trace</th></tr></thead>
                <tbody>
                  {timeline.map((e: any) => (
                    <tr key={e.id}>
                      <td className="mono tiny">{new Date(e.occurredAt).toISOString()}</td>
                      <td className="mono tiny">{e.type}</td>
                      <td className="tiny">{e.actor}{e.actorId ? ` (${e.actorId})` : ''}</td>
                      <td className="mono tiny dim">{e.traceId?.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="tiny dim" style={{ textTransform: 'uppercase', letterSpacing: '0.6px' }}>{label}</div>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Conversation({ transcript, kind }: { transcript: any; kind?: string }) {
  const turns = (transcript?.turns ?? []).filter((t: any) => !kind || t.kind === kind);
  if (turns.length === 0) return <Empty>No conversation recorded.</Empty>;
  return (
    <div>
      {turns.map((t: any) => (
        <div className="turn" key={t.id}>
          <div className={`turn-avatar ${t.speaker.toLowerCase()}`}>
            {t.speaker === 'CALLER' ? 'C' : t.speaker === 'AI' ? 'AI' : 'AG'}
          </div>
          <div className="turn-body">
            <div className="turn-who">
              {t.speakerName ?? t.speaker} · {clockTime(t.timestamp)} ·{' '}
              <span className="dim">{t.kind === 'AI_CONVERSATION' ? 'AI segment' : 'Agent segment'}</span>
            </div>
            <div className="turn-text">{t.content}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
