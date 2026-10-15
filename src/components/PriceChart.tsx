import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Bar } from '../data/api';
import type { LiveQuote, CompareState } from '../App';
import ForecastView from './ForecastView';
import SeasonalView from './SeasonalView';
import IndicatorsView from './IndicatorsView';
import { dirClass, fmt, pct } from './format';
import {
  COLORS, loadChartConfig, saveChartConfig, studyLabel, useModel, useModelOptions, useSignals, useStudyCatalog, useStudyValues,
  type ChartConfig, type Study, type StudyMeta,
} from './ChartStudies';
import { useHealth } from '../lib/server';

const C = { line: '#ffa028', ma: '#4fc3f7', b: '#c792ea', grid: '#161c24', axis: '#7d8794', tipBg: '#0d1117', tipLine: '#2a333f', fc: '#3ddc84', naive: '#7d8794', sig: '#4fc3f7' };
const TIP = { contentStyle: { background: C.tipBg, border: `1px solid ${C.tipLine}`, fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }, labelStyle: { color: C.axis } };

const RANGES = [
  { label: '1M', n: 22 },
  { label: '3M', n: 66 },
  { label: '6M', n: 130 },
  { label: '1Y', n: 260 },
  { label: '5Y', n: Infinity },
] as const;
type RangeLabel = (typeof RANGES)[number]['label'] | 'FCST' | 'SEAS' | 'LEAD';

type ComparePoint = { date: string; a: number; b: number };
type Row = Record<string, number | string | null | [number, number]> & { date: string };

function indexTo100(bars: Bar[]): Map<string, number> {
  if (!bars.length) return new Map();
  const base = bars[0].close;
  return new Map(bars.map((b) => [b.date, (b.close / base) * 100]));
}

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx, ay = ys[i] - my;
    num += ax * ay; da += ax * ax; db += ay * ay;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

let uidSeq = 0;
const newUid = () => `s${Date.now().toString(36)}${uidSeq++}`;

export default function PriceChart({ quote, history, compare, config: cfgProp, onConfig }: {
  quote: LiveQuote;
  history: Bar[] | null;
  compare: CompareState;
  config?: ChartConfig;
  onConfig?: (c: ChartConfig) => void;
}) {
  const [range, setRange] = useState<RangeLabel>('1Y');
  const [localCfg, setLocalCfg] = useState<ChartConfig>(loadChartConfig);
  const cfg = cfgProp ?? localCfg;
  const setCfg = (c: ChartConfig) => { saveChartConfig(c); onConfig ? onConfig(c) : setLocalCfg(c); };
  const fcst = range === 'FCST';
  const seas = range === 'SEAS';
  const lead = range === 'LEAD';
  const mlView = fcst || seas || lead;

  const catalog = useStudyCatalog();
  const metaOf = (id: string) => catalog.find((m) => m.id === id);
  const live = useMemo(() => {
    if (!history) return null;
    const h = history.slice();
    h[h.length - 1] = { ...h[h.length - 1], close: quote.last };
    return h;
  }, [history, quote.last]);
  const { values, errors } = useStudyValues(quote.id, live, cfg.studies, catalog);
  const model = useModel(quote.id, history, cfg.model, cfg.horizon);
  const signals = useSignals(cfg.signalRule);

  const overlays = cfg.studies.filter((s) => metaOf(s.id)?.pane === 'overlay');
  const subs = cfg.studies.filter((s) => metaOf(s.id)?.pane === 'sub');

  // ── Normal mode rows: history (+ forecast rows) with every study column ────
  const n = RANGES.find((r) => r.label === range)?.n ?? 260;
  const rows = useMemo<Row[]>(() => {
    if (!live || mlView || compare) return [];
    const full: Row[] = live.map((b, i) => {
      const r: Row = { date: b.date, close: b.close };
      for (const s of cfg.studies) {
        const v = values[s.uid];
        if (!v) continue;
        for (const [k, arr] of Object.entries(v)) r[`${s.uid}.${k}`] = arr[i] ?? null;
      }
      return r;
    });
    const vis = Number.isFinite(n) ? full.slice(-n) : full;
    if (model.res) {
      const lastRow = vis[vis.length - 1];
      lastRow.f50 = lastRow.close as number;
      lastRow.naive = lastRow.close as number;
      for (const [i, p] of model.res.forecast.entries()) {
        vis.push({ date: p.date, f50: p.p50, band: p.p10 !== null && p.p90 !== null ? [p.p10, p.p90] : null, naive: model.res.baseline[i]?.p50 ?? null });
      }
    }
    return vis;
  }, [live, mlView, compare, cfg.studies, values, n, model.res]);

  const histRows = useMemo(() => rows.filter((r) => r.close !== undefined), [rows]);
  const fires = useMemo(() => {
    if (!signals.bt || signals.bt.instrument !== quote.id) return [];
    const dates = new Set(histRows.map((r) => r.date));
    return signals.bt.fires.filter((f) => dates.has(f.date));
  }, [signals.bt, histRows, quote.id]);

  // ── Compare mode ──────────────────────────────────────────────────────────
  const compareData = useMemo<ComparePoint[]>(() => {
    if (!compare) return [];
    const mapA = indexTo100(compare.histA);
    const mapB = indexTo100(compare.histB);
    const dates = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
    const all = dates.filter((d) => mapA.has(d) && mapB.has(d)).map((d) => ({ date: d, a: mapA.get(d)!, b: mapB.get(d)! }));
    return Number.isFinite(n) ? all.slice(-n) : all;
  }, [compare, n]);

  const corr = useMemo(() => (compareData.length ? pearson(compareData.map((p) => p.a), compareData.map((p) => p.b)) : NaN), [compareData]);

  const stats = useMemo(() => {
    if (histRows.length < 2) return null;
    const closes = histRows.map((p) => p.close as number);
    const recent = closes.slice(-31);
    const rets = recent.slice(1).map((c, i) => Math.log(c / recent[i]));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    return { change: closes[closes.length - 1] / closes[0] - 1, hi: Math.max(...closes), lo: Math.min(...closes), vol30: sd * Math.sqrt(252) };
  }, [histRows]);

  const dayCh = quote.last / quote.prevClose - 1;
  const tickFmt = (d: string) => (range === '5Y' || range === '1Y' ? d.slice(0, 7) : d.slice(5));
  const colorOf = (s: Study) => COLORS[cfg.studies.indexOf(s) % COLORS.length];

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <div className="chart-id">
          <span className="chart-code">{compare ? `${compare.idA} / ${compare.idB}` : quote.code}</span>
          <span className="chart-name">{compare ? 'Indexed to 100' : quote.name}</span>
          {!fcst && !compare && <span className="chart-unit">{quote.unit}</span>}
        </div>
        {!mlView && !compare && (
          <div className="chart-last">
            <span className="big">{fmt(quote.last, quote.dp)}</span>
            <span className={dirClass(dayCh)}>{pct(dayCh)} 1D</span>
          </div>
        )}
        {compare && !isNaN(corr) && (
          <div className="chart-last">
            <span className="compare-corr" style={{ color: Math.abs(corr) > 0.7 ? C.line : C.b }}>ρ = {corr.toFixed(2)}</span>
            <span className="chart-unit">{range} correlation (levels)</span>
          </div>
        )}
        {!mlView && !compare && stats && (
          <dl className="chart-stats">
            <div><dt>{range} Chg</dt><dd className={dirClass(stats.change)}>{pct(stats.change)}</dd></div>
            <div><dt>{range} High</dt><dd>{fmt(stats.hi, quote.dp)}</dd></div>
            <div><dt>{range} Low</dt><dd>{fmt(stats.lo, quote.dp)}</dd></div>
            <div><dt>Vol 30D</dt><dd>{(stats.vol30 * 100).toFixed(1)}%</dd></div>
          </dl>
        )}
        {fcst && <span className="fc-tag">ML-01 FORECAST · REAL DATA</span>}
        {seas && <span className="fc-tag">ML-02 SEASONAL · REAL DATA</span>}
        {lead && <span className="fc-tag">ML-04 LEAD INDICATORS · REAL DATA</span>}
        <div className="ranges" role="group" aria-label="Date range">
          {([...RANGES.map((r) => r.label), ...(compare ? [] : ['FCST', 'SEAS', 'LEAD'])] as RangeLabel[]).map((label) => (
            <button key={label} type="button" className={label === range ? 'on' : undefined} onClick={() => setRange(label)}>{label}</button>
          ))}
        </div>
      </div>

      {!mlView && !compare && <StudyBar cfg={cfg} setCfg={setCfg} catalog={catalog} instrument={quote.id} errors={errors} model={model} signals={signals} fires={fires.length} colorOf={colorOf} />}

      {fcst ? (
        <ForecastView id={quote.id} />
      ) : seas ? (
        <SeasonalView id={quote.id} />
      ) : lead ? (
        <IndicatorsView id={quote.id} />
      ) : compare ? (
        <>
          <div className="chart-area">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={compareData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={C.grid} vertical={false} />
                <XAxis dataKey="date" tick={{ fill: C.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={48} tickFormatter={tickFmt} />
                <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: C.axis, fontSize: 10 }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => v.toFixed(0)} />
                <Tooltip {...TIP} formatter={(v: number, name: string) => [v.toFixed(1), name === 'a' ? compare.idA : compare.idB]} />
                <Legend wrapperStyle={{ fontSize: 10, paddingTop: 2 }} formatter={(name: string) => (name === 'a' ? compare.idA : compare.idB)} />
                <Line type="linear" dataKey="a" stroke={C.line} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line type="linear" dataKey="b" stroke={C.b} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span><i style={{ background: C.line }} />{compare.idA}</span>
            <span><i style={{ background: C.b }} />{compare.idB}</span>
            <span style={{ marginLeft: 'auto', color: C.axis, fontSize: 10 }}>COMPARE OFF to exit</span>
          </div>
        </>
      ) : (
        <>
          <div className="chart-area">
            {live ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} syncId="px" syncMethod="value" margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="px-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.line} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={C.line} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: C.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={48} tickFormatter={tickFmt} hide={subs.length > 0} />
                  <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: C.axis, fontSize: 10 }} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => fmt(v, quote.dp > 1 ? 1 : quote.dp)} />
                  <Tooltip {...TIP} formatter={(v: number | [number, number], name: string) => [Array.isArray(v) ? `${fmt(v[0], quote.dp)} – ${fmt(v[1], quote.dp)}` : fmt(v, quote.dp), name]} />
                  {model.res && <Area type="linear" dataKey="band" name="80% band (OOS errors)" stroke="none" fill={C.fc} fillOpacity={0.12} isAnimationActive={false} connectNulls />}
                  <Area type="linear" dataKey="close" name="Close" stroke={C.line} strokeWidth={1.5} fill="url(#px-fill)" isAnimationActive={false} dot={false} />
                  {overlays.flatMap((s) => (metaOf(s.id)?.outputs ?? ['value']).map((o, j) => (
                    <Line key={`${s.uid}.${o}`} type="linear" dataKey={`${s.uid}.${o}`} name={`${studyLabel(s, metaOf(s.id))}${o !== 'value' ? ` ${o}` : ''}`}
                      stroke={colorOf(s)} strokeWidth={1} strokeDasharray={j === 1 && (metaOf(s.id)?.outputs.length ?? 0) === 3 ? '4 3' : undefined} dot={false} isAnimationActive={false} connectNulls />
                  )))}
                  {model.res && <Line type="linear" dataKey="naive" name="Naive baseline" stroke={C.naive} strokeDasharray="2 3" strokeWidth={1} dot={false} isAnimationActive={false} />}
                  {model.res && <Line type="linear" dataKey="f50" name={model.res.model} stroke={C.fc} strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                  {fires.map((f) => <ReferenceDot key={f.date} x={f.date} y={f.price} r={3.5} fill={C.sig} stroke="#000" strokeWidth={1} />)}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty">Loading history…</div>
            )}
          </div>
          {live && subs.map((s) => {
            const meta = metaOf(s.id);
            return (
              <div key={s.uid} className="chart-sub">
                <span className="chart-sub-label" style={{ color: colorOf(s) }}>{studyLabel(s, meta)}</span>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={histRows} syncId="px" syncMethod="value" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: C.axis, fontSize: 9 }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={48} tickFormatter={tickFmt} hide={s !== subs[subs.length - 1]} />
                    <YAxis orientation="right" domain={['auto', 'auto']} tick={{ fill: C.axis, fontSize: 9 }} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))} />
                    <Tooltip {...TIP} formatter={(v: number, name: string) => [typeof v === 'number' ? v.toFixed(3) : v, name]} />
                    {(meta?.levels ?? []).map((l) => <ReferenceLine key={l} y={l} stroke={C.axis} strokeDasharray="2 3" />)}
                    {(meta?.outputs ?? ['value']).map((o, j) => (
                      <Line key={o} type="linear" dataKey={`${s.uid}.${o}`} name={o} stroke={j === 0 ? colorOf(s) : COLORS[(cfg.studies.indexOf(s) + j + 2) % COLORS.length]} strokeWidth={1.2} dot={false} isAnimationActive={false} connectNulls />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            );
          })}
          <div className="chart-legend">
            <span><i style={{ background: C.line }} />Close</span>
            {overlays.map((s) => <span key={s.uid}><i style={{ background: colorOf(s) }} />{studyLabel(s, metaOf(s.id))}</span>)}
            {model.res && <><span><i style={{ background: C.fc }} />{model.res.model} +{cfg.horizon}</span><span><i style={{ background: C.naive }} />Naive</span></>}
            {fires.length > 0 && <span><i style={{ background: C.sig, borderRadius: '50%', height: 6, width: 6 }} />Rule fires</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────────
function StudyBar({ cfg, setCfg, catalog, instrument, errors, model, signals, fires, colorOf }: {
  cfg: ChartConfig; setCfg: (c: ChartConfig) => void; catalog: StudyMeta[]; instrument: string; errors: Record<string, string>;
  model: ReturnType<typeof useModel>; signals: ReturnType<typeof useSignals>; fires: number; colorOf: (s: Study) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const models = useModelOptions();
  const health = useHealth();
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  const groups = useMemo(() => {
    const m = new Map<string, StudyMeta[]>();
    for (const s of catalog) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [catalog]);

  const add = (meta: StudyMeta) => {
    const params: Record<string, number | string> = Object.fromEntries(meta.params.map((p) => [p.key, p.default]));
    if (meta.needsOther) params.vs = instrument === 'GOLD' ? 'SILVER' : 'GOLD';
    const s = { uid: newUid(), id: meta.id, params };
    setCfg({ ...cfg, studies: [...cfg.studies, s] });
    setOpen(null);
    if (meta.params.length || meta.needsOther) setEdit(s.uid);
  };
  const update = (uid: string, params: Study['params']) => setCfg({ ...cfg, studies: cfg.studies.map((s) => (s.uid === uid ? { ...s, params } : s)) });
  const remove = (uid: string) => setCfg({ ...cfg, studies: cfg.studies.filter((s) => s.uid !== uid) });
  const ev = model.res?.evaluation;

  return (
    <div className="studybar" onClick={(e) => e.stopPropagation()}>
      <div className="sb-menu">
        <button className="sb-btn" onClick={() => setOpen(open === 'ind' ? null : 'ind')}>IND ▾</button>
        {open === 'ind' && (
          <div className="sb-pop">
            {groups.map(([g, items]) => (
              <div key={g} className="sb-group">
                <div className="sb-group-name">{g}</div>
                {items.map((m) => <button key={m.id} className="sb-item" title={m.description} onClick={() => add(m)}>{m.name}<span className="sub">{m.pane === 'overlay' ? 'overlay' : 'pane'}</span></button>)}
              </div>
            ))}
            {!health && <div className="sb-group sub">Start the server for Python indicators.</div>}
          </div>
        )}
      </div>

      {cfg.studies.map((s) => {
        const meta = catalog.find((m) => m.id === s.id);
        return (
          <span key={s.uid} className="sb-chip" style={{ borderColor: colorOf(s) }}>
            <button className="sb-chip-label" style={{ color: colorOf(s) }} onClick={() => setEdit(edit === s.uid ? null : s.uid)} title={errors[s.uid] ?? 'Edit parameters'}>
              {studyLabel(s, meta)}{errors[s.uid] && <span className="down"> !</span>}
            </button>
            <button className="sb-x" onClick={() => remove(s.uid)}>×</button>
            {edit === s.uid && meta && (
              <span className="sb-params">
                {meta.params.map((p) => (
                  <label key={p.key}>{p.label}<input type="number" step={p.step ?? 'any'} value={Number(s.params[p.key] ?? p.default)} onChange={(e) => update(s.uid, { ...s.params, [p.key]: Number(e.target.value) })} /></label>
                ))}
                {meta.needsOther && <label>vs<input value={String(s.params.vs ?? '')} onChange={(e) => update(s.uid, { ...s.params, vs: e.target.value.toUpperCase() })} /></label>}
              </span>
            )}
          </span>
        );
      })}

      <span className="sb-sep" />
      <label className="sb-field">MODEL
        <select value={cfg.model ?? ''} onChange={(e) => setCfg({ ...cfg, model: e.target.value || null })}>
          <option value="">none</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      {cfg.model && <label className="sb-field">+<input type="number" min={1} max={60} value={cfg.horizon} onChange={(e) => setCfg({ ...cfg, horizon: Math.max(1, Math.min(60, Number(e.target.value))) })} />bars</label>}
      {model.busy && <span className="sub">fitting…</span>}
      {model.err && <span className="down sb-small" title={model.err}>model error</span>}
      {ev && (
        <span className={`sb-skill ${ev.skill > 0.02 ? 'up' : ev.skill < -0.02 ? 'down' : 'flat'}`} title={`Rolling-origin backtest over ${ev.origins} origins at +${ev.horizon} bars. MAE ${ev.mae.toPrecision(4)} vs naive ${ev.naiveMae.toPrecision(4)}. ${model.res?.note ?? ''}`}>
          OOS skill vs naive {ev.skill >= 0 ? '+' : ''}{(ev.skill * 100).toFixed(1)}%
        </span>
      )}

      <span className="sb-sep" />
      <label className="sb-field">SIGNAL
        <select value={cfg.signalRule ?? ''} onChange={(e) => setCfg({ ...cfg, signalRule: e.target.value || null })} disabled={!health}>
          <option value="">{health ? 'none' : 'server off'}</option>
          {signals.rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      {signals.bt && (
        <span className="sb-small sub" title={signals.bt.note}>
          {signals.bt.instrument !== instrument ? `rule is on ${signals.bt.instrument}` : `${fires} fires shown · 5-bar fwd ${signals.bt.forwardReturn.avg === null ? 'n/a' : `${signals.bt.forwardReturn.avg.toFixed(2)}%`} vs ${signals.bt.forwardReturn.baselineAvg?.toFixed(2)}% base`}
        </span>
      )}
      {signals.err && <span className="down sb-small" title={signals.err}>signal error</span>}
    </div>
  );
}
