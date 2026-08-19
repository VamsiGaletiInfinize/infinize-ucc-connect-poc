import { useEffect, useState } from 'react';
import { Softphone } from './components/Softphone.tsx';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, subscribeRealtime } from './lib/api.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { Calls } from './pages/Calls.tsx';
import { CallDetail } from './pages/CallDetail.tsx';
import { Tickets } from './pages/Tickets.tsx';
import { TicketDetail } from './pages/TicketDetail.tsx';
import { Agents } from './pages/Agents.tsx';
import { Queues } from './pages/Queues.tsx';
import { Outbound } from './pages/Outbound.tsx';
import { Knowledge } from './pages/Knowledge.tsx';
import { Supervisor } from './pages/Supervisor.tsx';
import { LiveCall } from './pages/LiveCall.tsx';

const NAV = [
  { section: 'Operations' },
  { to: '/dashboard', icon: '◈', label: 'Dashboard' },
  { to: '/calls', icon: '☏', label: 'Calls' },
  { to: '/tickets', icon: '▤', label: 'Tickets' },
  { to: '/supervisor', icon: '◉', label: 'Supervisor' },
  { section: 'Contact Centre' },
  { to: '/agents', icon: '☺', label: 'Agents' },
  { to: '/queues', icon: '⋮⋮', label: 'Queues' },
  { to: '/outbound', icon: '↗', label: 'Outbound' },
  { section: 'Knowledge' },
  { to: '/knowledge', icon: '◫', label: 'Knowledge Base' },
  { section: 'Demo' },
  { to: '/live', icon: '●', label: 'Live Call Console' },
];

const TITLES: Record<string, string> = {
  '/dashboard': 'Operations Dashboard',
  '/calls': 'Calls',
  '/tickets': 'Tickets',
  '/agents': 'Agents',
  '/queues': 'Queues',
  '/outbound': 'Outbound Campaigns',
  '/knowledge': 'Knowledge Base',
  '/supervisor': 'Supervisor',
  '/live': 'Live Call Console',
};

/**
 * Which agent this browser is signed in as.
 *
 * Hard-coded for the POC because the API has no end-user authentication yet. In a real
 * deployment this comes from the authenticated session — see docs/security.md.
 */
const ACTING_AGENT_ID = 'agent-aditya';

export function App() {
  const location = useLocation();
  const [health, setHealth] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [counts, setCounts] = useState({ calls: 0, tickets: 0 });

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  // One realtime connection for the whole shell; pages refresh from it.
  useEffect(() => {
    const unsubscribe = subscribeRealtime((msg) => {
      if (msg.type === 'HELLO') setConnected(true);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const refresh = () =>
      Promise.all([api.listCalls(), api.listTickets()])
        .then(([calls, tickets]) =>
          setCounts({
            calls: calls.filter((c: any) => !c.endedAt).length,
            tickets: tickets.filter((t: any) => !['CLOSED', 'ABANDONED'].includes(t.status)).length,
          }),
        )
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [location.pathname]);

  const title =
    TITLES[location.pathname] ??
    (location.pathname.startsWith('/tickets/')
      ? 'Ticket Detail'
      : location.pathname.startsWith('/calls/')
        ? 'Call Detail'
        : 'Infinize UCC');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">Infinize UCC</div>
          <div className="brand-sub">Unified Contact Center</div>
        </div>
        <nav className="nav">
          {NAV.map((item, i) =>
            'section' in item ? (
              <div className="nav-section" key={`s${i}`}>
                {item.section}
              </div>
            ) : (
              <NavLink
                key={item.to}
                to={item.to!}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.to === '/calls' && counts.calls > 0 && (
                  <span className="nav-count">{counts.calls}</span>
                )}
                {item.to === '/tickets' && counts.tickets > 0 && (
                  <span className="nav-count">{counts.tickets}</span>
                )}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-softphone">
          <Softphone agentId={ACTING_AGENT_ID} />
        </div>
        <div className="sidebar-footer">
          <div className="row" style={{ gap: 6 }}>
            <span className={`dot ${connected ? 'green' : 'gray'}`} />
            <span>{connected ? 'Realtime connected' : 'Realtime offline'}</span>
          </div>
          {health && (
            <div style={{ marginTop: 6 }}>
              <div>
                Telephony:{' '}
                <span className={health.telephonyLive ? 'muted' : ''} style={{ color: health.telephonyLive ? undefined : 'var(--amber)' }}>
                  {health.telephonyLive ? 'Amazon Connect' : 'Simulated'}
                </span>
              </div>
              <div>
                Retrieval:{' '}
                {health.retrieval === 'BEDROCK_EMBEDDINGS' ? 'Bedrock embeddings' : 'Lexical fallback'}
              </div>
            </div>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-spacer" />
          <span className="tiny dim">Infinize University · infinize-university</span>
        </header>
        <div className="content">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/calls/:id" element={<CallDetail />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/queues" element={<Queues />} />
            <Route path="/outbound" element={<Outbound />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/supervisor" element={<Supervisor />} />
            <Route path="/live" element={<LiveCall />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
