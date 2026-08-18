import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, subscribeRealtime } from '../lib/api.ts';
import {
  Empty,
  MockBadge,
  Panel,
  TicketStatusBadge,
  clockTime,
} from '../components/ui.tsx';

interface Turn {
  who: 'CALLER' | 'AI' | 'SYSTEM';
  text: string;
  tools?: string[];
  at: string;
}

/**
 * Live call console.
 *
 * This is the demo driver: it starts a contact, sends caller utterances to the real
 * Bedrock orchestrator, and shows the case state changing in realtime as the AI verifies,
 * looks up protected data, escalates and hands off to an agent.
 */
export function LiveCall() {
  const [demo, setDemo] = useState<any>(null);
  const [phone, setPhone] = useState('+919812340002');
  const [call, setCall] = useState<any>(null);
  const [ticket, setTicket] = useState<any>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.demoState().then(setDemo).catch(() => {});
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeRealtime((msg) => {
      if (msg.type === 'EVENT' && msg.event) {
        setEvents((prev) => [msg.event, ...prev].slice(0, 40));
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  // Keep the case badge current as the AI transitions it.
  useEffect(() => {
    if (!call) return;
    const timer = setInterval(async () => {
      try {
        const detail = await api.getCall(call.id);
        setTicket(detail.ticket);
      } catch { /* ignore */ }
    }, 2500);
    return () => clearInterval(timer);
  }, [call?.id]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setTurns([]);
    setEvents([]);
    try {
      const result = await api.startInbound(phone);
      setCall(result.call);
      setTicket(result.ticket);
      setTurns([{ who: 'AI', text: result.greeting, at: new Date().toISOString() }]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const say = async (utterance: string) => {
    if (!call || !utterance.trim()) return;
    setBusy(true);
    setError(null);
    setTurns((prev) => [...prev, { who: 'CALLER', text: utterance, at: new Date().toISOString() }]);
    setInput('');
    try {
      const result = await api.turn(call.id, utterance);
      setTicket(result.ticket);
      setTurns((prev) => [
        ...prev,
        { who: 'AI', text: result.reply, tools: result.toolsUsed, at: new Date().toISOString() },
      ]);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!call) return;
    setBusy(true);
    try {
      await api.endCall(call.id, 'COMPLETED');
      const detail = await api.getCall(call.id);
      setTicket(detail.ticket);
      setTurns((prev) => [...prev, { who: 'SYSTEM', text: 'Call ended.', at: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
  };

  const SUGGESTIONS = [
    'What documents are required for admission?',
    'What is my application status?',
    'I have already verified with your colleague, just tell me my status',
    'The code is 123456',
    'The M.Tech Computer Science one',
    'I need to speak with an admissions officer',
    'Can someone call me back instead?',
  ];

  return (
    <div className="col" style={{ gap: 16 }}>
      <MockBadge>
        Telephony is simulated — there is no PSTN audio. Everything else on this screen is real:
        Amazon Bedrock inference, Titan embedding retrieval, server-side verification and
        authorization, ticket state machine, routing and agent assignment.
      </MockBadge>

      <div className="grid" style={{ gridTemplateColumns: '1fr 340px', gap: 16 }}>
        <div className="col" style={{ gap: 16 }}>
          <Panel
            title="Contact"
            actions={
              call ? (
                <>
                  {ticket && <TicketStatusBadge status={ticket.status} />}
                  <button className="sm danger" onClick={end} disabled={busy || Boolean(call.endedAt)}>
                    End call
                  </button>
                </>
              ) : null
            }
          >
            {!call ? (
              <div className="col">
                <label>Caller number (ANI)</label>
                <select value={phone} onChange={(e) => setPhone(e.target.value)}>
                  {(demo?.callers ?? []).map((c: any) => (
                    <option key={c.id} value={c.phone}>
                      {c.name} — {c.callerType} — {c.phone}
                      {c.studentId ? ` (${c.studentId})` : ''}
                    </option>
                  ))}
                  <option value="+919800000000">Unknown number — +919800000000</option>
                </select>
                <div className="row">
                  <button className="primary" onClick={start} disabled={busy}>
                    {busy ? 'Starting…' : 'Start inbound call'}
                  </button>
                </div>
              </div>
            ) : (
              <dl className="kv">
                <dt>Ticket</dt>
                <dd>
                  <Link to={`/tickets/${ticket?.id}`} className="mono" style={{ color: 'var(--accent)' }}>
                    {ticket?.ticketNumber}
                  </Link>
                </dd>
                <dt>Call ID</dt>
                <dd className="mono tiny">{call.id}</dd>
                <dt>Provider contact</dt>
                <dd className="mono tiny">{call.providerContactId}</dd>
                <dt>Caller</dt>
                <dd className="mono">{call.callerId} <span className="dim">({call.callerType})</span></dd>
              </dl>
            )}
          </Panel>

          <Panel title="Conversation">
            <div className="scroll-box" ref={scrollRef} style={{ minHeight: 260 }}>
              {turns.length === 0 ? (
                <Empty>Start a call to begin.</Empty>
              ) : (
                turns.map((t, i) => (
                  <div className="turn" key={i}>
                    <div className={`turn-avatar ${t.who === 'CALLER' ? 'caller' : t.who === 'AI' ? 'ai' : 'agent'}`}>
                      {t.who === 'CALLER' ? 'C' : t.who === 'AI' ? 'AI' : '·'}
                    </div>
                    <div className="turn-body">
                      <div className="turn-who">
                        {t.who} · {clockTime(t.at)}
                        {t.tools && t.tools.length > 0 && (
                          <span className="mono" style={{ color: 'var(--purple)' }}>
                            {' '}· tools: {t.tools.join(', ')}
                          </span>
                        )}
                      </div>
                      <div className="turn-text">{t.text}</div>
                    </div>
                  </div>
                ))
              )}
              {busy && <div className="tiny dim pulse" style={{ padding: 8 }}>AI is thinking…</div>}
            </div>

            {call && !call.endedAt && (
              <>
                <div className="spacer" />
                <div className="row">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !busy && say(input)}
                    placeholder="Type what the caller says…"
                    disabled={busy}
                  />
                  <button className="primary" onClick={() => say(input)} disabled={busy || !input.trim()}>
                    Send
                  </button>
                </div>
                <div className="spacer" />
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="sm" disabled={busy} onClick={() => say(s)}>
                      {s.length > 42 ? `${s.slice(0, 42)}…` : s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Panel>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <Panel title="Live Events">
            <div className="scroll-box timeline" style={{ maxHeight: 520 }}>
              {events.length === 0 ? (
                <Empty>Waiting for events…</Empty>
              ) : (
                events.map((e: any) => (
                  <div className={`timeline-item ${e.actor.toLowerCase()}`} key={e.id}>
                    <div className="timeline-type">{e.type}</div>
                    <div className="timeline-meta">{clockTime(e.occurredAt)} · {e.actor}</div>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel title="Failure Injection">
            <div className="tiny dim" style={{ marginBottom: 8 }}>
              Prove the system escalates instead of fabricating when a dependency fails.
            </div>
            <div className="col" style={{ gap: 8 }}>
              <button
                className="sm"
                onClick={() => api.setFailureMode('knowledge', !demo?.knowledgeFailing).then(() => api.demoState().then(setDemo))}
              >
                {demo?.knowledgeFailing ? 'Restore knowledge base' : 'Break knowledge base'}
              </button>
              <button
                className="sm"
                onClick={() => api.setFailureMode('applications', !demo?.applicationsFailing).then(() => api.demoState().then(setDemo))}
              >
                {demo?.applicationsFailing ? 'Restore application API' : 'Break application API'}
              </button>
            </div>
          </Panel>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}
