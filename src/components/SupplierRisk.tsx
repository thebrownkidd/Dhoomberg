import { useEffect, useState } from 'react';
import { getSuppliers, type Supplier } from '../data/api';

const DIM_LABELS: Record<string, string> = {
  concentration: 'Conc',
  financial: 'Fin',
  geopolitical: 'Geo',
  climate: 'Clim',
};

function RagDot({ rag }: { rag: 'RED' | 'AMBER' | 'GREEN' }) {
  return <span className={`score ${rag.toLowerCase()}`}>{rag === 'RED' ? '!' : rag === 'AMBER' ? '~' : 'OK'}</span>;
}

function DimBars({ dims }: { dims: Record<string, number> }) {
  return (
    <div className="supp-dims">
      {Object.entries(dims).map(([k, v]) => (
        <div key={k} className="supp-dim">
          <span className="supp-dim-label">{DIM_LABELS[k] ?? k}</span>
          <div className="supp-dim-track">
            <div className="supp-dim-fill" style={{
              width: `${v}%`,
              background: v >= 70 ? 'var(--down)' : v >= 40 ? 'var(--warn)' : 'var(--up)',
            }} />
          </div>
          <span className="supp-dim-val">{v.toFixed(0)}</span>
        </div>
      ))}
    </div>
  );
}

export default function SupplierRisk() {
  const [state, setState] = useState<{ suppliers?: Supplier[]; note?: string; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getSuppliers()
      .then(({ meta, suppliers }) =>
        alive && setState({ suppliers, note: meta.dataSources?.concentration })
      )
      .catch((e: Error) => alive && setState({ error: e.message }));
    return () => { alive = false; };
  }, []);

  if (state?.error) return <div className="empty fc-error">{state.error}</div>;
  if (!state?.suppliers) return <div className="empty">Loading supplier risk…</div>;

  const { suppliers, note } = state;
  const redCount = suppliers.filter((s) => s.ragStatus === 'RED').length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="supp-summary">
        <span className={redCount > 0 ? 'down' : 'up'}>{redCount} RED</span>
        <span className="flat"> · {suppliers.filter((s) => s.ragStatus === 'AMBER').length} AMBER</span>
        <span className="up"> · {suppliers.filter((s) => s.ragStatus === 'GREEN').length} GREEN</span>
        {note && <span className="sub"> · concentration+financial: synthetic demo</span>}
      </div>
      <table className="t supp">
        <thead>
          <tr>
            <th className="l">Supplier</th>
            <th className="l">Commodity</th>
            <th>Score</th>
            <th className="l">Dimensions</th>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id} title={`Country: ${s.country} · Spend: ${s.spendPct}% · Credit: ${s.creditScore}`}>
              <td className="l">
                <div className="cp-name">{s.name}</div>
                <div className="cp-sub">{s.country} · top risk: {s.topDriver}</div>
              </td>
              <td className="l"><span className="sub">{s.commodity}</span></td>
              <td>
                <RagDot rag={s.ragStatus} />
                <span className="sub" style={{ marginLeft: 4 }}>{s.riskScore.toFixed(0)}</span>
              </td>
              <td><DimBars dims={s.dimensions} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
