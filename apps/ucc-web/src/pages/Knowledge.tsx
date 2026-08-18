import { useState } from 'react';
import { api } from '../lib/api.ts';
import { usePoll } from '../hooks/usePoll.ts';
import { Empty, Panel } from '../components/ui.tsx';

export function Knowledge() {
  const { data, loading } = usePoll(() => api.knowledge(), 0);
  const [query, setQuery] = useState('What documents are required for admission?');
  const [hits, setHits] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setBusy(true); setError(null); setHits(null);
    try { setHits((await api.searchKnowledge(query)).hits); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <Empty>Loading knowledge base…</Empty>;

  return (
    <div className="col" style={{ gap: 16 }}>
      <Panel title="Public Knowledge Base">
        <dl className="kv">
          <dt>Retrieval</dt>
          <dd>
            {data?.retrieval === 'BEDROCK_EMBEDDINGS' ? (
              <span className="badge green">Amazon Titan Text Embeddings v2 (semantic)</span>
            ) : (
              <span className="badge amber">Lexical fallback</span>
            )}
          </dd>
          <dt>Indexed chunks</dt><dd>{data?.chunks}</dd>
          <dt>Documents</dt><dd>{data?.documents?.length}</dd>
          <dt>Health</dt>
          <dd>{data?.healthy ? <span className="badge green">Healthy</span> : <span className="badge red">Unavailable</span>}</dd>
        </dl>
        <div className="spacer" />
        <div className="tiny dim">
          Public information only. Transactional student and application data is never in this
          index — it is served exclusively by the university APIs behind the authorization gate.
        </div>
      </Panel>

      <Panel title="Documents" flush>
        <table>
          <thead><tr><th>Document</th><th>Category</th><th>Chunks</th></tr></thead>
          <tbody>
            {(data?.documents ?? []).map((d: any) => (
              <tr key={d.documentId}>
                <td>{d.title}</td>
                <td className="tiny muted">{d.category}</td>
                <td>{d.chunks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Retrieval Test">
        <div className="row">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
          <button className="primary" onClick={search} disabled={busy}>Search</button>
        </div>
        {error && <><div className="spacer" /><div className="error-banner">{error}</div></>}
        {hits && (
          <>
            <div className="spacer" />
            {hits.length === 0 ? (
              <Empty>No relevant passages. The AI would escalate rather than guess.</Empty>
            ) : (
              hits.map((h: any) => (
                <div key={h.chunkId} style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 12, marginBottom: 14 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong className="small">{h.title}</strong>
                    <span className="badge gray">{h.category}</span>
                    <span className="tiny dim mono">score {h.score.toFixed(3)}</span>
                  </div>
                  <div className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                    {h.content.slice(0, 420)}{h.content.length > 420 ? '…' : ''}
                  </div>
                  <div className="tiny dim mono" style={{ marginTop: 4 }}>{h.sourceUri}</div>
                </div>
              ))
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
