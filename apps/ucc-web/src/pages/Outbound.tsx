import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import { Empty, Panel, clockTime } from '../components/ui.tsx';

export function Outbound() {
  const { data, loading, refresh } = usePoll(() => api.listCampaigns(), 5000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const campaigns = data ?? [];

  const create = async () => {
    setBusy(true); setError(null);
    try { await api.createCampaign(); await refresh(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const run = async (id: string) => {
    setBusy(true); setError(null);
    try { setResult(await api.runCampaign(id)); await refresh(); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Panel
        title="Outbound Campaigns"
        actions={<button className="primary sm" onClick={create} disabled={busy}>New deadline reminder campaign</button>}
        flush
      >
        {campaigns.length === 0 ? (
          <Empty>No campaigns. Create the application deadline reminder campaign to begin.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Campaign</th><th>Category</th><th>Status</th><th>Targets</th><th>Calls</th><th /></tr>
            </thead>
            <tbody>
              {campaigns.map((c: any) => (
                <tr key={c.id}>
                  <td>
                    <div>{c.name}</div>
                    <div className="tiny dim">{c.description}</div>
                  </td>
                  <td className="tiny muted">{c.category.replace(/_/g, ' ')}</td>
                  <td>
                    <span className={`badge ${c.status === 'COMPLETED' ? 'green' : c.status === 'RUNNING' ? 'amber' : 'gray'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td>{c.targetCallerIds.length}</td>
                  <td>{c.callIds.length}</td>
                  <td>
                    <button className="sm primary" onClick={() => run(c.id)} disabled={busy || c.status === 'RUNNING'}>
                      Run campaign
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <Panel title="Campaign Run — every outbound contact opened its own case" flush>
          <table>
            <thead><tr><th>Ticket</th><th>Phone</th><th>Opening line</th></tr></thead>
            <tbody>
              {result.contacts.map((c: any) => (
                <tr key={c.callId}>
                  <td>
                    <Link to={`/tickets/${c.ticketId}`} className="mono" style={{ color: 'var(--accent)' }}>
                      {c.ticketNumber}
                    </Link>
                  </td>
                  <td className="mono tiny">{c.phone}</td>
                  <td className="small">{c.opening}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
