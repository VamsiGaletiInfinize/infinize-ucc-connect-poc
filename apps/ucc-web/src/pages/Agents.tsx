import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import { AgentStatusBadge, Empty, Panel } from '../components/ui.tsx';

const STATUSES = ['AVAILABLE', 'ON_CALL', 'AFTER_CALL_WORK', 'BREAK', 'OFFLINE'];

export function Agents() {
  const { data, loading, refresh } = usePoll(() => api.listAgents(), 4000);
  if (loading && !data) return <Empty>Loading agents…</Empty>;
  const agents = data ?? [];

  return (
    <Panel title={`Agents (${agents.length})`} flush>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Email</th>
            <th>Routing Profile</th>
            <th>Status</th>
            <th>Current Call</th>
            <th>Set Status</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a: any) => (
            <tr key={a.id}>
              <td>
                <div>{a.firstName} {a.lastName}</div>
                <div className="tiny dim mono">{a.id}</div>
              </td>
              <td className="tiny muted mono">{a.email}</td>
              <td className="tiny muted">{a.routingProfileName}</td>
              <td><AgentStatusBadge status={a.status} /></td>
              <td className="mono tiny">{a.currentCallId ? `${a.currentCallId.slice(0, 12)}…` : '—'}</td>
              <td>
                <select
                  value={a.status}
                  onChange={(e) => api.setAgentStatus(a.id, e.target.value).then(refresh)}
                  style={{ width: 150 }}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
