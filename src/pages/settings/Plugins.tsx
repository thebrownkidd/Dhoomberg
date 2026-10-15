import { useState } from 'react';
import { INDICATORS } from '../../../shared/indicators';
import { BUILTIN_MODELS } from '../../../shared/models';
import { api, useServerData } from '../../lib/server';
import Connections from './Connections';

type PyInfo = { plugins: { name: string; kind: string; title: string; description: string; file: string; params: Record<string, unknown> }[]; errors: Record<string, string>; error: string | null };

const EXAMPLE = `# plugins/my_signals.py: saved files reload automatically
from dhoomberg_runtime import indicator, model, signal, datasource

@indicator(name="ema_gap", title="EMA gap %", params={"fast": 10, "slow": 40}, pane="sub", levels=[0])
def ema_gap(series, fast, slow):           # pandas Series of closes, indexed by date
    f = series.ewm(span=fast).mean()
    s = series.ewm(span=slow).mean()
    return (f / s - 1) * 100                 # one value per bar

@signal(name="gap_flip", params={"fast": 10, "slow": 40})
def gap_flip(series, fast, slow):            # 0/1, usable as a rule condition
    g = series.ewm(span=fast).mean() - series.ewm(span=slow).mean()
    return ((g > 0) & (g.shift(1) <= 0)).astype(float)

@model(name="my_model", title="My model")
def my_model(series, horizon):               # return \`horizon\` future prices
    return [series.iloc[-1]] * horizon       # it is scored against naive automatically`;

function usePython() {
  return useServerData(() => api.get<{ python: PyInfo }>('/plugins').then((r) => r.python), ['plugins']);
}

export function PythonPanel() {
  const py = usePython();
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <div className="st-toolbar">
        <button onClick={() => { setBusy(true); api.post('/python/reload').finally(() => { setBusy(false); py.reload(); }); }} disabled={busy}>{busy ? 'Reloading…' : 'Reload plugins'}</button>
        <span className="sub">Folder: <code>plugins/</code> · Runtime: <code>dhoomberg_runtime</code> · Requirements: <code>pip install -r requirements.txt</code></span>
      </div>
      {py.data?.error && <div className="st-error">Python: {py.data.error}</div>}
      {Object.entries(py.data?.errors ?? {}).map(([f, e]) => <div key={f} className="st-error"><b>{f}</b> failed to load<pre>{e}</pre></div>)}
      <table className="t st-table">
        <thead><tr><th className="l">Plugin</th><th className="l">Kind</th><th className="l">File</th><th className="l">Params</th></tr></thead>
        <tbody>
          {py.data?.plugins.map((p) => (
            <tr key={p.name}><td className="l"><b>{p.title}</b> <span className="sub">py:{p.name}</span><div className="st-small sub">{p.description}</div></td><td className="l">{p.kind}</td><td className="l">{p.file}</td><td className="l st-small">{JSON.stringify(p.params)}</td></tr>
          ))}
        </tbody>
      </table>
      <h3 className="st-h">Write your own</h3>
      <pre className="st-code">{EXAMPLE}</pre>
      <p className="st-small sub">Plugins run as you, with full access to this machine, so only drop in code you trust. Each call has a 30 s timeout; a crashed or hung worker restarts automatically.</p>
    </div>
  );
}

export function IndicatorsTab() {
  return (
    <div>
      <p className="st-intro">Indicators appear in the chart's <b>IND</b> dropdown and as rule operands. Built-ins are validated against TA-Lib; Python plugins appear next to them automatically.</p>
      <h3 className="st-h">Built-in ({INDICATORS.length})</h3>
      <table className="t st-table">
        <thead><tr><th className="l">Indicator</th><th className="l">Group</th><th className="l">Pane</th><th className="l">Outputs</th><th className="l">Notes</th></tr></thead>
        <tbody>
          {INDICATORS.map((m) => (
            <tr key={m.id}><td className="l"><b>{m.name}</b> <span className="sub">{m.id}</span></td><td className="l">{m.group}</td><td className="l">{m.pane}</td><td className="l">{m.outputs.join(', ')}</td><td className="l st-small">{m.description}</td></tr>
          ))}
        </tbody>
      </table>
      <h3 className="st-h">Python plugins</h3>
      <PythonPanel />
    </div>
  );
}

export function ModelsTab() {
  return (
    <div>
      <h3 className="st-h">Built-in forecast models</h3>
      <p className="st-intro">Every forecast is plotted with the naive (last value) baseline and its rolling out-of-sample error. Skill &gt; 0 means it beat naive on this instrument's history; most models, most of the time, do not.</p>
      <table className="t st-table">
        <thead><tr><th className="l">Model</th><th className="l">What it does</th></tr></thead>
        <tbody>{BUILTIN_MODELS.map((m) => <tr key={m.id}><td className="l"><b>{m.name}</b></td><td className="l st-small">{m.description}</td></tr>)}</tbody>
      </table>
      <h3 className="st-h">Model APIs</h3>
      <Connections kind="model" intro="Language models power the LLM-analyst signal (bias + confidence + rationale, usable in rules). Custom HTTP models are your own forecasting service." />
    </div>
  );
}
