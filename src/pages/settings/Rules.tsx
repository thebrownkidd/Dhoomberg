import { useState } from 'react';
import type { Rule } from '../../../shared/types';
import RuleBuilder, { emptyRule } from '../../components/RuleBuilder';
import { useCatalog } from '../../lib/catalog';
import { api, useServerData } from '../../lib/server';

type RuleRow = Rule & { state: { lastEval?: string; lastResult?: boolean; lastFire?: string; lastError?: string | null } };

const ago = (iso?: string) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export default function Rules({ initialInstrument }: { initialInstrument?: string }) {
  const cat = useCatalog();
  const rules = useServerData(() => api.get<RuleRow[]>('/rules'), ['audit']);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);

  if (cat.error) return <div className="st-error">{cat.error}</div>;
  if (!cat.data) return <div className="st-empty">Loading…</div>;

  if (editing) {
    return <RuleBuilder initial={editing} cat={cat.data} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); rules.reload(); }} />;
  }

  return (
    <div>
      <p className="st-intro">
        Rules watch prices, indicators (built-in or Python), model forecasts, news sentiment, LLM views, demand and positioning data,
        then notify people, push data to other systems, or send orders through the risk guard. They run on the server, so they keep working
        with the browser closed. Backtest before enabling.
      </p>
      <div className="st-toolbar">
        <button className="primary" onClick={() => setEditing(emptyRule(initialInstrument ?? cat.data!.instruments[0]?.id ?? 'SUGAR'))}>New rule</button>
      </div>
      {!rules.data?.length && <div className="st-empty">No rules yet.</div>}
      {!!rules.data?.length && (
        <table className="t st-table">
          <thead><tr><th className="l">Rule</th><th className="l">Mode</th><th className="l">Actions</th><th>Last check</th><th>Now</th><th>Last fired</th><th /></tr></thead>
          <tbody>
            {rules.data.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'st-off'}>
                <td className="l">
                  <label className="st-switch"><input type="checkbox" checked={r.enabled} onChange={() => api.put(`/rules/${r.id}`, { enabled: !r.enabled }).then(rules.reload)} /><span>{r.name}</span></label>
                  {r.state.lastError && <div className="down st-small">{r.state.lastError}</div>}
                </td>
                <td className="l"><span className={`st-mode ${r.mode}`}>{r.mode.toUpperCase()}</span></td>
                <td className="l st-small">{r.actions.map((a) => (a.type === 'notify' ? 'notify' : `${a.side} ${a.qty ?? `$${a.notional}`} ${a.instrument}`)).join(', ') || '—'}</td>
                <td>{ago(r.state.lastEval)}</td>
                <td>{r.state.lastResult === undefined ? '—' : r.state.lastResult ? <span className="up">TRUE</span> : <span className="sub">false</span>}</td>
                <td>{ago(r.state.lastFire)}</td>
                <td>
                  <button className="link" onClick={() => setEditing(r)}>Edit</button>
                  <button className="link danger" onClick={() => window.confirm(`Delete rule "${r.name}"?`) && api.del(`/rules/${r.id}`).then(rules.reload)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
