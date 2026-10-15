import { useState } from 'react';
import type { AuditEntry, Connection, PluginManifest } from '../../../shared/types';
import { api, useServerData } from '../../lib/server';
import { usePlugins } from './Connections';

export function KeysTab() {
  const conns = useServerData(() => api.get<Connection[]>('/connections'), ['connections']);
  const plugins = usePlugins();
  const [msg, setMsg] = useState<string | null>(null);
  const rows = (conns.data ?? []).flatMap((c) => {
    const p = plugins.data?.find((x) => x.id === c.pluginId);
    const fields = Object.entries(p?.configSchema.properties ?? {}).filter(([, s]) => s['x-secret']);
    return fields.map(([k, s]) => ({ c, p: p as PluginManifest, key: k, title: s.title ?? k, hint: c.secrets[k] }));
  });

  async function rotate(c: Connection, key: string, title: string) {
    const v = window.prompt(`New value for "${title}" on ${c.name}:`);
    if (!v) return;
    await api.put(`/connections/${c.id}`, { config: { ...c.config, [key]: v } });
    const t = await api.post<{ ok: boolean; message: string }>(`/connections/${c.id}/test`);
    setMsg(`${c.name}: ${t.ok ? 'OK' : 'FAILED'} · ${t.message}`);
  }

  return (
    <div>
      <p className="st-intro">
        Secrets are encrypted with AES-256-GCM in <code>.dhoomberg/dhoomberg.db</code>. The key lives in <code>.dhoomberg/master.key</code>, or in the
        <code> DHOOMBERG_MASTER_KEY</code> environment variable if you set it. Plaintext never leaves the server: this page only shows the last 4 characters.
      </p>
      {msg && <div className="st-ok">{msg}</div>}
      <table className="t st-table">
        <thead><tr><th className="l">Connection</th><th className="l">Field</th><th className="l">Stored</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.c.id}-${r.key}`}>
              <td className="l">{r.c.name} <span className="sub">{r.p?.name}</span></td>
              <td className="l">{r.title}</td>
              <td className="l">{r.hint ?? <span className="down">not set</span>}</td>
              <td><button className="link" onClick={() => rotate(r.c, r.key, r.title)}>{r.hint ? 'Rotate' : 'Set'}</button></td>
            </tr>
          ))}
          {!rows.length && <tr><td className="l sub" colSpan={4}>No secrets stored.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function ImportExportTab() {
  const [report, setReport] = useState<string | null>(null);
  async function exportCfg() {
    const cfg = await api.get<object>('/config/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `dhoomberg-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function importCfg(f: File) {
    try {
      const r = await api.post<{ connections: number; instruments: number; rules: number; skipped: string[]; note: string }>('/config/import', JSON.parse(await f.text()));
      setReport(`Imported ${r.connections} connections, ${r.instruments} instruments, ${r.rules} rules. ${r.note}${r.skipped.length ? `\nSkipped:\n${r.skipped.join('\n')}` : ''}`);
    } catch (e) {
      setReport(`Import failed: ${(e as Error).message}`);
    }
  }
  return (
    <div>
      <p className="st-intro">Share a setup with a colleague or move it to another machine. The file holds connections, instruments, rules, risk limits and layout. It never contains API keys or passwords; those must be re-entered after import. Imported rules arrive disabled.</p>
      <div className="st-toolbar">
        <button className="primary" onClick={exportCfg}>Export config</button>
        <label className="st-upload">Import config<input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && importCfg(e.target.files[0])} /></label>
      </div>
      {report && <pre className="st-code">{report}</pre>}
    </div>
  );
}

const KIND_CLASS = (k: string) => (/rejected|error|failed|halt/.test(k) ? 'down' : /filled|sent|approved|armed|resume/.test(k) ? 'up' : /fired|requested|submitted|suggested/.test(k) ? 'warn' : '');

export function AuditTab() {
  const [kind, setKind] = useState('');
  const [limit, setLimit] = useState(200);
  const audit = useServerData(() => api.get<AuditEntry[]>(`/audit?limit=${limit}${kind ? `&kind=${kind}` : ''}`), ['audit'], [kind, limit]);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <p className="st-intro">Append-only record of every evaluation that fired, every notification, approval, rejection (with reasons), order, fill, config change, arm/disarm and HALT. The database refuses updates and deletes on this table.</p>
      <div className="st-toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All events</option>
          {['rule_fired', 'notify_sent', 'notify_failed', 'approval_requested', 'approval_approved', 'approval_rejected', 'approval_expired', 'order_submitted', 'order_filled', 'order_accepted', 'order_rejected', 'order_error', 'order_suggested', 'halt', 'resume', 'live_armed', 'live_disarmed', 'risk_limits', 'rule_error', 'connection_created', 'connection_updated', 'config_imported'].map((k) => <option key={k}>{k}</option>)}
        </select>
        <a className="st-btnlink" href="/api/audit/export">Export CSV</a>
      </div>
      <table className="t st-table st-audit">
        <thead><tr><th className="l">Time</th><th className="l">Event</th><th className="l">Detail</th></tr></thead>
        <tbody>
          {audit.data?.map((e) => (
            <tr key={e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <td className="l st-small">{new Date(e.ts).toLocaleString('en-GB')}</td>
              <td className={`l ${KIND_CLASS(e.kind)}`}>{e.kind}</td>
              <td className="l st-small">{open === e.id ? <pre className="st-code">{JSON.stringify(e.detail, null, 2)}</pre> : summary(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {audit.data && audit.data.length >= limit && <button onClick={() => setLimit(limit + 500)}>Load more</button>}
    </div>
  );
}

function summary(e: AuditEntry): string {
  const d = e.detail as Record<string, any>;
  if (d.order) return `${d.order.side?.toUpperCase()} ${d.order.qty} ${d.order.instrument} · ${d.order.status}${d.order.reason ? ` · ${d.order.reason}` : ''}`;
  if (d.approval) return `${d.approval.ruleName}: ${d.approval.intent.side} ${d.approval.intent.qty} ${d.approval.intent.instrument}${d.approval.result ? ` · ${d.approval.result}` : ''}`;
  if (d.rule && typeof d.rule === 'string') return `${d.rule} @ ${d.price ?? ''} (${d.bar ?? ''})`;
  if (d.error) return d.error;
  if (d.result) return d.result;
  return JSON.stringify(d).slice(0, 160);
}
