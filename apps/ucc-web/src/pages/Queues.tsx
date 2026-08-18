import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import { Empty, Panel, clockTime } from '../components/ui.tsx';

export function Queues() {
  const queues = usePoll(() => api.listQueues(), 4000);
  const callbacks = usePoll(() => api.listCallbacks(), 4000);

  if (queues.loading && !queues.data) return <Empty>Loading queues…</Empty>;

  return (
    <div className="col" style={{ gap: 16 }}>
      <Panel title="Department Queues" flush>
        <table>
          <thead>
            <tr>
              <th>Department</th>
              <th>Connect Queue</th>
              <th>Waiting</th>
              <th>Handling</th>
              <th>Agents Available</th>
              <th>Agents On Call</th>
              <th>SLA</th>
            </tr>
          </thead>
          <tbody>
            {(queues.data ?? []).map((q: any) => (
              <tr key={q.departmentId}>
                <td>{q.name}</td>
                <td className="mono tiny muted">{q.queueName}</td>
                <td><span className={q.waiting > 0 ? 'badge amber' : 'badge gray'}>{q.waiting}</span></td>
                <td>{q.inProgress}</td>
                <td><span className={q.agentsAvailable > 0 ? 'badge green' : 'badge red'}>{q.agentsAvailable}</span></td>
                <td>{q.agentsOnCall}</td>
                <td className="tiny muted">{q.slaSeconds}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title={`Callbacks (${(callbacks.data ?? []).length})`} flush>
        {(callbacks.data ?? []).length === 0 ? (
          <Empty>No callbacks queued.</Empty>
        ) : (
          <table>
            <thead>
              <tr><th>Callback</th><th>Phone</th><th>Status</th><th>Scheduled</th><th>Agent</th><th /></tr>
            </thead>
            <tbody>
              {(callbacks.data ?? []).map((c: any) => (
                <tr key={c.id}>
                  <td className="mono tiny">{c.id.slice(0, 16)}…</td>
                  <td className="mono tiny">{c.phone}</td>
                  <td>
                    <span className={`badge ${c.status === 'COMPLETED' ? 'green' : c.status === 'QUEUED' ? 'amber' : 'gray'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="tiny muted">{clockTime(c.scheduledFor)}</td>
                  <td className="tiny muted">{c.agentId ?? '—'}</td>
                  <td>
                    {c.status === 'QUEUED' && (
                      <button
                        className="sm"
                        onClick={() => api.completeCallback(c.id, 'agent-aditya').then(callbacks.refresh)}
                      >
                        Complete as Aditya
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
