import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import {
  Empty,
  Panel,
  PriorityBadge,
  TicketStatusBadge,
  VerificationBadge,
  relativeTime,
} from '../components/ui.tsx';

export function Tickets() {
  const { data, loading } = usePoll(() => api.listTickets(), 4000);
  const navigate = useNavigate();

  if (loading && !data) return <Empty>Loading tickets…</Empty>;
  const tickets = data ?? [];

  return (
    <Panel title={`Tickets (${tickets.length})`} flush>
      {tickets.length === 0 ? (
        <Empty>No cases yet. Every call opens one automatically.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Status</th>
              <th>Caller Type</th>
              <th>Intent</th>
              <th>Category</th>
              <th>Priority</th>
              <th>Verification</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t: any) => (
              <tr key={t.id} className="clickable" onClick={() => navigate(`/tickets/${t.id}`)}>
                <td className="mono" style={{ color: 'var(--accent)' }}>
                  {t.ticketNumber}
                </td>
                <td>
                  <TicketStatusBadge status={t.status} />
                </td>
                <td className="tiny muted">{t.callerType}</td>
                <td className="tiny">{t.intent ?? '—'}</td>
                <td className="tiny muted">{t.category.replace(/_/g, ' ')}</td>
                <td>
                  <PriorityBadge priority={t.priority} />
                </td>
                <td>
                  <VerificationBadge status={t.verificationStatus} />
                </td>
                <td className="tiny dim">{relativeTime(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
