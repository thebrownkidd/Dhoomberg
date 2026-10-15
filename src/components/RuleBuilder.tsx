import { useEffect, useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { IndicatorMeta } from '../../shared/indicators';
import type { BacktestResult, Condition, Connection, Group, Operand, Operator, PluginManifest, Rule, RuleAction } from '../../shared/types';
import { api } from '../lib/server';

export type Catalog = {
  instruments: { id: string; name: string; realtime?: boolean }[];
  indicators: (IndicatorMeta | (Omit<IndicatorMeta, 'group'> & { group: string }))[];
  models: { id: string; name: string }[];
  actions: Connection[];
  brokers: Connection[];
  llms: Connection[];
  plugins: PluginManifest[];
};

const OPS: { v: Operator; l: string }[] = [
  { v: '>', l: '>' }, { v: '<', l: '<' }, { v: '>=', l: '≥' }, { v: '<=', l: '≤' },
  { v: 'crosses_above', l: 'crosses above' }, { v: 'crosses_below', l: 'crosses below' },
  { v: 'pct_change_gt', l: '% change over N bars >' }, { v: 'pct_change_lt', l: '% change over N bars <' },
  { v: 'between', l: 'between' },
];
const DEMAND_SERIES = ['NAPM', 'INDPRO', 'UMCSENT', 'WTISTUS', 'FAO_FFPI'];

export function emptyRule(instrument: string): Partial<Rule> {
  return {
    name: '', enabled: false, mode: 'notify', cooldownMin: 60, cadence: { type: 'tick' }, activeHours: null,
    when: { kind: 'group', mode: 'all', items: [{ kind: 'cond', left: { type: 'indicator', instrument, indicator: 'rsi', params: { period: 14 } }, op: 'crosses_below', right: { type: 'const', value: 30 } }] },
    actions: [],
  };
}

function defaultOperand(type: Operand['type'], instrument: string, cat: Catalog): Operand {
  switch (type) {
    case 'const': return { type, value: 0 };
    case 'price': return { type, instrument };
    case 'indicator': return { type, instrument, indicator: 'sma', params: { period: 20 } };
    case 'model': return { type, instrument, model: cat.models[0]?.id ?? 'builtin:holt', horizon: 10 };
    case 'news': return { type, instrument, field: 'sentiment_avg', windowHours: 24 };
    case 'llm': return { type, instrument, connectionId: cat.llms[0]?.id ?? '' };
    case 'demand': return { type, series: 'NAPM' };
    case 'cot': return { type, instrument };
  }
}

function OperandEditor({ o, onChange, cat, allowConst = true }: { o: Operand; onChange: (o: Operand) => void; cat: Catalog; allowConst?: boolean }) {
  const inst = 'instrument' in o ? o.instrument : cat.instruments[0]?.id ?? 'SUGAR';
  const InstSel = ({ value, set }: { value: string; set: (v: string) => void }) => (
    <select value={value} onChange={(e) => set(e.target.value)}>
      {cat.instruments.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}
    </select>
  );
  const meta = o.type === 'indicator' ? cat.indicators.find((m) => m.id === o.indicator) : undefined;
  return (
    <span className="rb-operand">
      <select value={o.type} onChange={(e) => onChange(defaultOperand(e.target.value as Operand['type'], inst, cat))}>
        {allowConst && <option value="const">Value</option>}
        <option value="price">Price</option>
        <option value="indicator">Indicator</option>
        <option value="model">Model forecast % chg</option>
        <option value="news">News sentiment</option>
        <option value="llm">LLM bias (−1…1)</option>
        <option value="demand">Demand series</option>
        <option value="cot">COT net long %</option>
      </select>
      {o.type === 'const' && <input type="number" step="any" className="rb-num" value={o.value} onChange={(e) => onChange({ ...o, value: Number(e.target.value) })} />}
      {'instrument' in o && <InstSel value={o.instrument} set={(v) => onChange({ ...o, instrument: v } as Operand)} />}
      {o.type === 'indicator' && (
        <>
          <select value={o.indicator} onChange={(e) => {
            const m = cat.indicators.find((x) => x.id === e.target.value);
            onChange({ ...o, indicator: e.target.value, params: Object.fromEntries((m?.params ?? []).map((p) => [p.key, p.default])), output: m?.outputs[0] });
          }}>
            {groupBy(cat.indicators, (m) => m.group).map(([g, items]) => (
              <optgroup key={g} label={g}>{items.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>
            ))}
          </select>
          {meta?.params.map((p) => (
            <label key={p.key} className="rb-param">{p.label}
              <input type="number" step="any" className="rb-num" value={Number(o.params[p.key] ?? p.default)} onChange={(e) => onChange({ ...o, params: { ...o.params, [p.key]: Number(e.target.value) } })} />
            </label>
          ))}
          {'needsOther' in (meta ?? {}) && (meta as IndicatorMeta).needsOther && (
            <label className="rb-param">vs <InstSel value={String(o.params.vs ?? '')} set={(v) => onChange({ ...o, params: { ...o.params, vs: v } })} /></label>
          )}
          {meta && meta.outputs.length > 1 && (
            <select value={o.output ?? meta.outputs[0]} onChange={(e) => onChange({ ...o, output: e.target.value })}>
              {meta.outputs.map((x) => <option key={x}>{x}</option>)}
            </select>
          )}
        </>
      )}
      {o.type === 'model' && (
        <>
          <select value={o.model} onChange={(e) => onChange({ ...o, model: e.target.value })}>{cat.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <label className="rb-param">bars<input type="number" className="rb-num" value={o.horizon} onChange={(e) => onChange({ ...o, horizon: Number(e.target.value) })} /></label>
        </>
      )}
      {o.type === 'news' && (
        <>
          <select value={o.field} onChange={(e) => onChange({ ...o, field: e.target.value as typeof o.field })}>
            <option value="sentiment_avg">avg sentiment (−1…1)</option><option value="bullish_count">bullish headlines</option><option value="bearish_count">bearish headlines</option>
          </select>
          <label className="rb-param">last h<input type="number" className="rb-num" value={o.windowHours} onChange={(e) => onChange({ ...o, windowHours: Number(e.target.value) })} /></label>
        </>
      )}
      {o.type === 'llm' && (
        <select value={o.connectionId} onChange={(e) => onChange({ ...o, connectionId: e.target.value })}>
          {!cat.llms.length && <option value="">Connect an LLM in Models first</option>}
          {cat.llms.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {o.type === 'demand' && (
        <select value={o.series} onChange={(e) => onChange({ ...o, series: e.target.value })}>{DEMAND_SERIES.map((s) => <option key={s}>{s}</option>)}</select>
      )}
    </span>
  );
}

function CondEditor({ c, onChange, onRemove, cat }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void; cat: Catalog }) {
  return (
    <div className="rb-cond">
      <OperandEditor o={c.left} cat={cat} allowConst={false} onChange={(left) => onChange({ ...c, left })} />
      <select className="rb-op" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as Operator })}>
        {OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
      {(c.op === 'pct_change_gt' || c.op === 'pct_change_lt') && (
        <label className="rb-param">N<input type="number" className="rb-num" value={c.lookback ?? 1} onChange={(e) => onChange({ ...c, lookback: Number(e.target.value) })} /></label>
      )}
      <OperandEditor o={c.right} cat={cat} onChange={(right) => onChange({ ...c, right })} />
      {c.op === 'between' && <label className="rb-param">and<input type="number" step="any" className="rb-num" value={c.upper ?? 0} onChange={(e) => onChange({ ...c, upper: Number(e.target.value) })} /></label>}
      <button className="rb-x" onClick={onRemove} title="Remove condition">×</button>
    </div>
  );
}

function GroupEditor({ g, onChange, onRemove, cat, depth = 0 }: { g: Group; onChange: (g: Group) => void; onRemove?: () => void; cat: Catalog; depth?: number }) {
  const inst = cat.instruments[0]?.id ?? 'SUGAR';
  const setItem = (i: number, v: Condition | Group) => onChange({ ...g, items: g.items.map((x, j) => (j === i ? v : x)) });
  const removeItem = (i: number) => onChange({ ...g, items: g.items.filter((_, j) => j !== i) });
  return (
    <div className={`rb-group depth-${depth}`}>
      <div className="rb-group-head">
        <select value={g.mode} onChange={(e) => onChange({ ...g, mode: e.target.value as Group['mode'] })}>
          <option value="all">ALL of these are true</option>
          <option value="any">ANY of these is true</option>
        </select>
        {onRemove && <button className="rb-x" onClick={onRemove} title="Remove group">×</button>}
      </div>
      {g.items.map((it, i) => it.kind === 'group'
        ? <GroupEditor key={i} g={it} cat={cat} depth={depth + 1} onChange={(v) => setItem(i, v)} onRemove={() => removeItem(i)} />
        : <CondEditor key={i} c={it} cat={cat} onChange={(v) => setItem(i, v)} onRemove={() => removeItem(i)} />)}
      <div className="rb-add">
        <button onClick={() => onChange({ ...g, items: [...g.items, { kind: 'cond', left: { type: 'price', instrument: inst }, op: '>', right: { type: 'const', value: 0 } }] })}>+ condition</button>
        {depth < 2 && <button onClick={() => onChange({ ...g, items: [...g.items, { kind: 'group', mode: g.mode === 'all' ? 'any' : 'all', items: [] }] })}>+ group</button>}
      </div>
    </div>
  );
}

function ActionEditor({ a, onChange, onRemove, cat }: { a: RuleAction; onChange: (a: RuleAction) => void; onRemove: () => void; cat: Catalog }) {
  if (a.type === 'notify') {
    return (
      <div className="rb-action">
        <span className="rb-tag">NOTIFY</span>
        <select value={a.connectionId} onChange={(e) => onChange({ ...a, connectionId: e.target.value })}>
          {!cat.actions.length && <option value="">Connect Slack/email/… in Actions first</option>}
          {cat.actions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="rb-x" onClick={onRemove}>×</button>
      </div>
    );
  }
  return (
    <div className="rb-action">
      <span className="rb-tag warn">ORDER</span>
      <select value={a.connectionId} onChange={(e) => onChange({ ...a, connectionId: e.target.value })}>
        {!cat.brokers.length && <option value="">Connect a broker first (Paper is built in)</option>}
        {cat.brokers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={a.side} onChange={(e) => onChange({ ...a, side: e.target.value as 'buy' | 'sell' })}><option value="buy">BUY</option><option value="sell">SELL</option></select>
      <select value={a.notional ? 'notional' : 'qty'} onChange={(e) => onChange(e.target.value === 'qty' ? { ...a, qty: 1, notional: undefined } : { ...a, qty: undefined, notional: 1000 })}>
        <option value="qty">qty</option><option value="notional">$ notional</option>
      </select>
      <input type="number" step="any" className="rb-num" value={a.notional ?? a.qty ?? 0} onChange={(e) => onChange(a.notional ? { ...a, notional: Number(e.target.value) } : { ...a, qty: Number(e.target.value) })} />
      <select value={a.instrument} onChange={(e) => onChange({ ...a, instrument: e.target.value })}>{cat.instruments.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}</select>
      <input className="rb-sym" placeholder="broker symbol (optional)" value={a.symbol ?? ''} onChange={(e) => onChange({ ...a, symbol: e.target.value || undefined })} />
      <select value={a.orderType} onChange={(e) => onChange({ ...a, orderType: e.target.value as 'market' | 'limit' })}><option value="market">MKT</option><option value="limit">LMT</option></select>
      {a.orderType === 'limit' && <label className="rb-param">offset %<input type="number" step="any" className="rb-num" value={a.limitOffsetPct ?? 0.1} onChange={(e) => onChange({ ...a, limitOffsetPct: Number(e.target.value) })} /></label>}
      <select value={a.tif} onChange={(e) => onChange({ ...a, tif: e.target.value as 'day' | 'gtc' | 'ioc' })}><option value="day">DAY</option><option value="gtc">GTC</option><option value="ioc">IOC</option></select>
      <button className="rb-x" onClick={onRemove}>×</button>
    </div>
  );
}

type EvalResult = { result: boolean; details: { label: string; left: number | null; right: number | null; result: boolean | null }[]; bar: string; price: number | null };

export default function RuleBuilder({ initial, cat, onSaved, onCancel }: { initial: Partial<Rule>; cat: Catalog; onSaved: () => void; onCancel: () => void }) {
  const [r, setR] = useState<Partial<Rule>>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [ev, setEv] = useState<EvalResult | null>(null);
  const [bt, setBt] = useState<BacktestResult | null>(null);
  const [btH, setBtH] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);
  const hasOrders = (r.actions ?? []).some((a) => a.type === 'order');

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setErr(null);
    try { return await fn(); } catch (e) { setErr((e as Error).message); return undefined; } finally { setBusy(null); }
  }

  const evaluate = () => run('eval', async () => setEv(await api.post<EvalResult>('/rules/evaluate', { when: r.when })));
  const backtest = () => run('bt', async () => setBt(await api.post<BacktestResult>('/rules/backtest', { rule: r, horizonBars: btH })));
  const save = (enabled: boolean) => run('save', async () => {
    if (enabled && r.mode === 'auto' && !window.confirm('Auto mode places orders without asking (still subject to risk limits and the broker\'s "allow auto" switch). Enable?')) return;
    const body = { ...r, enabled };
    if (r.id) await api.put(`/rules/${r.id}`, body); else await api.post('/rules', body);
    onSaved();
  });

  return (
    <div className="rb">
      <div className="rb-meta">
        <input className="rb-name" placeholder="Rule name, e.g. Cocoa oversold + bearish news" value={r.name ?? ''} onChange={(e) => setR({ ...r, name: e.target.value })} />
      </div>
      <div className="rb-section">WHEN</div>
      <GroupEditor g={r.when!} cat={cat} onChange={(when) => setR({ ...r, when })} />

      <div className="rb-section">THEN</div>
      <div className="rb-actions">
        {(r.actions ?? []).map((a, i) => (
          <ActionEditor key={i} a={a} cat={cat} onChange={(v) => setR({ ...r, actions: r.actions!.map((x, j) => (j === i ? v : x)) })} onRemove={() => setR({ ...r, actions: r.actions!.filter((_, j) => j !== i) })} />
        ))}
        <div className="rb-add">
          <button onClick={() => setR({ ...r, actions: [...(r.actions ?? []), { type: 'notify', connectionId: cat.actions[0]?.id ?? '' }] })}>+ notify</button>
          <button onClick={() => setR({ ...r, actions: [...(r.actions ?? []), { type: 'order', connectionId: cat.brokers[0]?.id ?? '', instrument: cat.instruments[0]?.id ?? 'SUGAR', side: 'buy', qty: 1, orderType: 'market', tif: 'day' }] })}>+ order</button>
        </div>
      </div>

      <div className="rb-section">HOW</div>
      <div className="rb-how">
        <label>Execution
          <select value={r.mode} onChange={(e) => setR({ ...r, mode: e.target.value as Rule['mode'] })}>
            <option value="notify">Notify only (orders are suggested, never placed)</option>
            <option value="confirm">Confirm (orders wait for APPROVE)</option>
            <option value="auto">Auto (orders placed if the broker allows auto)</option>
          </select>
        </label>
        <label>Check
          <select value={r.cadence?.type} onChange={(e) => setR({ ...r, cadence: e.target.value === 'interval' ? { type: 'interval', minutes: 15 } : { type: e.target.value as 'tick' | 'bar' } })}>
            <option value="tick">every engine tick (~15 s)</option><option value="interval">every N minutes</option><option value="bar">once per new bar</option>
          </select>
        </label>
        {r.cadence?.type === 'interval' && <label>Minutes<input type="number" className="rb-num" value={r.cadence.minutes} onChange={(e) => setR({ ...r, cadence: { type: 'interval', minutes: Number(e.target.value) } })} /></label>}
        <label>Cooldown (min)<input type="number" className="rb-num" value={r.cooldownMin ?? 60} onChange={(e) => setR({ ...r, cooldownMin: Number(e.target.value) })} /></label>
        <label className="rb-check"><input type="checkbox" checked={!!r.activeHours} onChange={(e) => setR({ ...r, activeHours: e.target.checked ? { tz: 'America/New_York', start: '09:30', end: '16:00', days: [1, 2, 3, 4, 5] } : null })} />Only during hours</label>
        {r.activeHours && (
          <span className="rb-hours">
            <input value={r.activeHours.start} onChange={(e) => setR({ ...r, activeHours: { ...r.activeHours!, start: e.target.value } })} />–
            <input value={r.activeHours.end} onChange={(e) => setR({ ...r, activeHours: { ...r.activeHours!, end: e.target.value } })} />
            <input className="rb-tz" value={r.activeHours.tz} onChange={(e) => setR({ ...r, activeHours: { ...r.activeHours!, tz: e.target.value } })} />
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <button key={i} className={r.activeHours!.days.includes(i) ? 'on' : ''} onClick={() => setR({ ...r, activeHours: { ...r.activeHours!, days: r.activeHours!.days.includes(i) ? r.activeHours!.days.filter((x) => x !== i) : [...r.activeHours!.days, i] } })}>{d}</button>
            ))}
          </span>
        )}
      </div>
      {hasOrders && r.mode !== 'notify' && <div className="rb-warn">Orders pass the risk guard every time (limits, fresh quote, trading hours, HALT). Live brokers also need to be armed in Brokers &amp; Risk.</div>}

      {err && <div className="st-error">{err}</div>}

      <div className="rb-buttons">
        <button onClick={evaluate} disabled={!!busy}>{busy === 'eval' ? 'Evaluating…' : 'Evaluate now'}</button>
        <label className="rb-param">horizon<input type="number" className="rb-num" value={btH} onChange={(e) => setBtH(Number(e.target.value))} />bars</label>
        <button onClick={backtest} disabled={!!busy}>{busy === 'bt' ? 'Backtesting…' : 'Backtest'}</button>
        <span className="rb-spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button onClick={() => save(false)} disabled={!!busy}>Save disabled</button>
        <button className="primary" onClick={() => save(true)} disabled={!!busy}>Save &amp; enable</button>
      </div>

      {ev && (
        <div className="rb-eval">
          <div className={ev.result ? 'up' : 'sub'}>Right now ({ev.bar}{ev.price !== null ? ` @ ${ev.price}` : ''}): rule is {ev.result ? 'TRUE (it would fire if it just became true)' : 'false'}</div>
          {ev.details.map((d, i) => (
            <div key={i} className="rb-eval-row">
              <span className={d.result === null ? 'warn' : d.result ? 'up' : 'down'}>{d.result === null ? '?' : d.result ? '✓' : '✗'}</span>
              <span>{d.label}</span><span className="sub">{fmtV(d.left)} vs {fmtV(d.right)}</span>
            </div>
          ))}
        </div>
      )}
      {bt && <BacktestView bt={bt} />}
    </div>
  );
}

const fmtV = (v: number | null) => (v === null ? 'n/a' : Math.abs(v) >= 100 ? v.toFixed(2) : v.toPrecision(4));
const pctV = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

function BacktestView({ bt }: { bt: BacktestResult }) {
  const [series, setSeries] = useState<{ date: string; close: number }[] | null>(null);
  useEffect(() => { api.get<{ date: string; close: number }[]>(`/series/${bt.instrument}`).then(setSeries).catch(() => setSeries([])); }, [bt.instrument]);
  const f = bt.forwardReturn;
  const edge = f.avg !== null && f.baselineAvg !== null ? f.avg - f.baselineAvg : null;
  return (
    <div className="rb-bt">
      <div className="rb-bt-stats">
        <div><dt>Fires</dt><dd>{bt.fires.length}</dd></div>
        <div><dt>{f.horizonBars}-bar fwd ({f.direction})</dt><dd className={f.avg !== null && f.avg > 0 ? 'up' : 'down'}>{pctV(f.avg)}</dd></div>
        <div><dt>Unconditional</dt><dd>{pctV(f.baselineAvg)}</dd></div>
        <div><dt>Edge vs baseline</dt><dd className={edge !== null && edge > 0 ? 'up' : 'down'}>{pctV(edge)}</dd></div>
        <div><dt>Hit rate</dt><dd>{f.hitRate === null ? 'n/a' : `${Math.round(f.hitRate * 100)}%`}</dd></div>
        <div><dt>1st / 2nd half</dt><dd>{pctV(f.firstHalfAvg)} / {pctV(f.secondHalfAvg)}</dd></div>
      </div>
      <div className="rb-bt-note">{bt.note}</div>
      {series && series.length > 0 && (
        <div className="rb-bt-chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#161c24" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: '#7d8794', fontSize: 10 }} minTickGap={60} tickFormatter={(d: string) => d.slice(0, 7)} />
              <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: '#7d8794', fontSize: 10 }} width={56} />
              <Tooltip contentStyle={{ background: '#0d1117', border: '1px solid #2a333f', fontSize: 11 }} />
              <Line dataKey="close" stroke="#ffa028" dot={false} strokeWidth={1.2} isAnimationActive={false} />
              {bt.fires.map((x) => <ReferenceDot key={x.date} x={x.date} y={x.price} r={3} fill="#4fc3f7" stroke="none" />)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function groupBy<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return [...m.entries()];
}
