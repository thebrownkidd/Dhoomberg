import { useState } from 'react';
import type { Connection, Instrument } from '../../../shared/types';
import { api, useServerData } from '../../lib/server';

type Row = Instrument & { realtime: boolean };
const EMPTY = { id: '', name: '', code: '', unit: '', dp: 2, multiplier: 1, connectionId: '', symbol: '' };

export default function Instruments() {
  const inst = useServerData(() => api.get<Row[]>('/instruments'), ['connections']);
  const sources = useServerData(() => api.get<Connection[]>('/connections?kind=datasource'), ['connections']);
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState('');

  const srcName = (id: string) => (id === 'demo' ? 'Demo (simulated)' : sources.data?.find((s) => s.id === id)?.name ?? id);

  async function save() {
    if (!form) return;
    setMsg(null);
    try {
      const saved = await api.post<Instrument>('/instruments', form);
      const bars = await api.get<{ date: string; close: number }[]>(`/series/${saved.id}`);
      setMsg({ ok: true, text: `${saved.id}: ${bars.length} bars loaded, last ${bars.at(-1)?.date} = ${bars.at(-1)?.close}. It is now in your watchlist.` });
      setForm(null);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function upload(file: File) {
    setMsg(null);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const { file: stored } = await api.post<{ file: string }>('/uploads', { name: file.name, contentBase64: btoa(bin) });
      const firstLine = new TextDecoder().decode(buf.slice(0, 2000)).split(/\r?\n/)[0];
      const cols = firstLine.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      const dateCol = cols.find((c) => /date|time|period/i.test(c)) ?? cols[0];
      const conn = await api.post<Connection>('/connections', { pluginId: 'csv', name: file.name, config: { file: stored, dateField: dateCol, closeField: cols.find((c) => c !== dateCol) ?? 'close' } });
      const valueCols = cols.filter((c) => c !== dateCol);
      setForm({ ...EMPTY, connectionId: conn.id, symbol: valueCols[0] ?? '', id: (valueCols[0] ?? 'CSV').toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 20), name: valueCols[0] ?? file.name });
      setMsg({ ok: true, text: `Uploaded. Columns: ${valueCols.join(', ')}. Each one can be its own instrument (symbol = column name).` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const rows = (inst.data ?? []).filter((r) => !filter || `${r.id} ${r.name} ${r.symbol}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <p className="st-intro">
        An instrument is any price series from any connected data source. Add new ones (any symbol your source supports), or re-point a
        built-in commodity from the demo feed to a real one. The multiplier turns price × quantity into notional for risk limits (e.g. 1000 for a CL contract).
      </p>
      <div className="st-toolbar">
        <button className="primary" onClick={() => setForm({ ...EMPTY, connectionId: sources.data?.[0]?.id ?? 'demo' })}>Add instrument</button>
        <label className="st-upload">Upload CSV<input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
        <input className="st-search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {msg && <div className={msg.ok ? 'st-ok' : 'st-error'}>{msg.text}</div>}

      {form && (
        <div className="st-editor">
          <div className="st-editor-head"><span>Instrument</span></div>
          <div className="st-grid2">
            <Field label="ID (used in commands)" value={form.id} onChange={(v) => setForm({ ...form, id: v.toUpperCase() })} />
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field label="Short code" value={form.code} onChange={(v) => setForm({ ...form, code: v.toUpperCase() })} />
            <Field label="Unit" value={form.unit} onChange={(v) => setForm({ ...form, unit: v })} placeholder="$/bbl" />
            <Field label="Decimals" type="number" value={String(form.dp)} onChange={(v) => setForm({ ...form, dp: Number(v) })} />
            <Field label="Contract multiplier" type="number" value={String(form.multiplier)} onChange={(v) => setForm({ ...form, multiplier: Number(v) })} />
            <div className="sf-row">
              <label className="sf-label">Data source</label>
              <div className="sf-input">
                <select value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
                  <option value="demo">Demo (simulated)</option>
                  {sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <Field label="Symbol at the source" value={form.symbol} onChange={(v) => setForm({ ...form, symbol: v })} placeholder="CL=F, DCOILBRENTEU, XAU/USD, column name…" />
          </div>
          <div className="st-editor-foot">
            <button onClick={() => setForm(null)}>Cancel</button>
            <button className="primary" onClick={save}>Save & load</button>
          </div>
        </div>
      )}

      <table className="t st-table">
        <thead><tr><th className="l">ID</th><th className="l">Name</th><th className="l">Source</th><th className="l">Symbol</th><th>Mult.</th><th className="l">Live-order eligible</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="l"><span className="tk">{r.id}</span></td>
              <td className="l">{r.name}</td>
              <td className="l">{srcName(r.connectionId)}</td>
              <td className="l">{r.symbol}</td>
              <td>{r.multiplier}</td>
              <td className="l">{r.realtime ? <span className="up">yes (real-time)</span> : <span className="sub">no: alerts &amp; paper only</span>}</td>
              <td>
                <button className="link" onClick={() => setForm({ id: r.id, name: r.name, code: r.code, unit: r.unit, dp: r.dp, multiplier: r.multiplier, connectionId: r.connectionId, symbol: r.symbol })}>Edit</button>
                {(r.custom || r.connectionId !== 'demo') && <button className="link danger" onClick={() => api.del(`/instruments/${r.id}`)}>{r.custom ? 'Delete' : 'Reset'}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div className="sf-row">
      <label className="sf-label">{label}</label>
      <div className="sf-input"><input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></div>
    </div>
  );
}
