import { useMemo, useState } from 'react';
import type { Connection, PluginKind, PluginManifest } from '../../../shared/types';
import SchemaForm, { withDefaults } from '../../components/SchemaForm';
import { api, useServerData } from '../../lib/server';

type Props = { kind: PluginKind; intro: string; renderExtra?: (c: Connection, p: PluginManifest | undefined) => React.ReactNode };

type Editing = { mode: 'new'; plugin: PluginManifest } | { mode: 'edit'; plugin: PluginManifest; conn: Connection };

export function usePlugins() {
  return useServerData(() => api.get<{ plugins: PluginManifest[] }>('/plugins').then((r) => r.plugins), ['plugins']);
}

export default function Connections({ kind, intro, renderExtra }: Props) {
  const plugins = usePlugins();
  const conns = useServerData(() => api.get<Connection[]>(`/connections?kind=${kind}`), ['connections']);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; ok: boolean; message: string } | null>(null);

  const catalog = useMemo(() => {
    const list = (plugins.data ?? []).filter((p) => p.kind === kind && p.id !== 'demo' && (!q || `${p.name} ${p.description} ${p.category}`.toLowerCase().includes(q.toLowerCase())));
    const groups = new Map<string, PluginManifest[]>();
    for (const p of list) groups.set(p.category, [...(groups.get(p.category) ?? []), p]);
    return [...groups.entries()];
  }, [plugins.data, kind, q]);

  const byId = (id: string) => plugins.data?.find((p) => p.id === id);

  async function test(id: string) {
    setBusy(id);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/connections/${id}/test`);
      setFlash({ id, ...r });
    } catch (e) {
      setFlash({ id, ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function toggle(c: Connection) {
    await api.put(`/connections/${c.id}`, { enabled: !c.enabled });
  }

  async function remove(c: Connection) {
    if (!window.confirm(`Delete "${c.name}"? Its stored secrets are erased.`)) return;
    await api.del(`/connections/${c.id}`);
  }

  if (plugins.error || conns.error) return <div className="st-error">{plugins.error ?? conns.error}</div>;

  return (
    <div className="st-conns">
      <p className="st-intro">{intro}</p>

      <h3 className="st-h">Connected</h3>
      {!conns.data?.length && <div className="st-empty">Nothing connected yet. Pick one below.</div>}
      <div className="st-list">
        {conns.data?.map((c) => {
          const p = byId(c.pluginId);
          const t = flash?.id === c.id ? flash : c.lastTest;
          return (
            <div key={c.id} className={`st-conn${c.enabled ? '' : ' off'}`}>
              <span className={`st-dot ${t ? (t.ok ? 'ok' : 'bad') : 'unk'}`} title={t ? t.message : 'Not tested'} />
              <div className="st-conn-main">
                <div className="st-conn-name">{c.name} <span className="sub">{p?.name ?? c.pluginId}</span></div>
                {t && <div className={`st-conn-msg ${t.ok ? 'up' : 'down'}`}>{t.message}</div>}
                {renderExtra?.(c, p)}
              </div>
              <div className="st-conn-actions">
                <button onClick={() => test(c.id)} disabled={busy === c.id}>{busy === c.id ? 'Testing…' : 'Test'}</button>
                {p && <button onClick={() => setEditing({ mode: 'edit', plugin: p, conn: c })}>Edit</button>}
                <button onClick={() => toggle(c)}>{c.enabled ? 'Disable' : 'Enable'}</button>
                <button className="danger" onClick={() => remove(c)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && <Editor editing={editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); test(id); }} />}

      <div className="st-catalog-head">
        <h3 className="st-h">Add a connection</h3>
        <input className="st-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {catalog.map(([cat, items]) => (
        <div key={cat} className="st-cat">
          <div className="st-cat-name">{cat}</div>
          <div className="st-cards">
            {items.map((p) => (
              <div key={p.id} className="st-card">
                <div className="st-card-name">{p.name}{p.capabilities?.realtime && <span className="st-badge">real-time</span>}{p.capabilities?.live && <span className="st-badge warn">live trading</span>}{p.capabilities?.llm && <span className="st-badge">LLM</span>}{p.source === 'python' && <span className="st-badge">python</span>}</div>
                <div className="st-card-desc">{p.description}</div>
                <div className="st-card-foot">
                  {p.docsUrl && <a href={p.docsUrl} target="_blank" rel="noopener noreferrer">Docs ↗</a>}
                  <button onClick={() => setEditing({ mode: 'new', plugin: p })}>Connect</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Editor({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: (id: string) => void }) {
  const { plugin } = editing;
  const [name, setName] = useState(editing.mode === 'edit' ? editing.conn.name : plugin.name);
  const [config, setConfig] = useState<Record<string, unknown>>(editing.mode === 'edit' ? editing.conn.config : {});
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const full = withDefaults(plugin.configSchema, config);
      const missing = (plugin.configSchema.required ?? []).filter((k) => {
        const s = plugin.configSchema.properties?.[k];
        const hasSecret = editing.mode === 'edit' && !!editing.conn.secrets[k];
        return (full[k] === undefined || full[k] === '') && !(s?.['x-secret'] && hasSecret);
      });
      if (missing.length) throw new Error(`Required: ${missing.map((k) => plugin.configSchema.properties?.[k]?.title ?? k).join(', ')}`);
      const c = editing.mode === 'new'
        ? await api.post<Connection>('/connections', { pluginId: plugin.id, name, config: full })
        : await api.put<Connection>(`/connections/${editing.conn.id}`, { name, config: full });
      onSaved(c.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="st-editor">
      <div className="st-editor-head">
        <span>{editing.mode === 'new' ? 'Connect' : 'Edit'} · {plugin.name}</span>
        {plugin.docsUrl && <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer">Where do I get these? ↗</a>}
      </div>
      <p className="st-card-desc">{plugin.description}</p>
      <div className="sf-row">
        <label className="sf-label" htmlFor="conn-name">Name</label>
        <div className="sf-input"><input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
      </div>
      <SchemaForm schema={plugin.configSchema} value={config} secretHints={editing.mode === 'edit' ? editing.conn.secrets : {}} onChange={setConfig} />
      {err && <div className="st-error">{err}</div>}
      <div className="st-editor-foot">
        <span className="sub">Secrets are encrypted on this machine and never sent back to the browser.</span>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save & test'}</button>
      </div>
    </div>
  );
}
