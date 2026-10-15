import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getForecast, type ForecastResult } from '../data/api';
import { dirClass, fmt, pct } from './format';

const C = {
  line: '#ffa028',
  p50: '#ffa028',
  ext: '#7d8794',
  band: 'rgba(255,160,40,0.14)',
  grid: '#161c24',
  axis: '#7d8794',
  tipBg: '#0d1117',
  tipLine: '#2a333f',
};

type Point = {
  date: string;
  close?: number;
  p10?: number;
  pBand?: number;
  p50v?: number; // validated horizons
  p50x?: number; // horizons that failed the test: shown, but not claimed
};

const LABELS: Record<string, string> = { close: 'Actual', p50v: 'P50', p50x: 'P50 (unvalidated)', p10: 'P10' };

export default function ForecastView({ id }: { id: string }) {
  const [state, setState] = useState<{ id: string; data?: ForecastResult; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getForecast(id)
      .then((data) => alive && setState({ id, data }))
      .catch((e: Error) => alive && setState({ id, error: e.message }));
    return () => {
      alive = false;
    };
  }, [id]);

  const f = state?.id === id ? state.data : undefined;
  const validH = useMemo(() => {
    if (!f) return 0;
    let n = 0;
    while (n < f.horizons.length && f.horizons[n].pass) n++;
    return n;
  }, [f]);

  const points = useMemo<Point[]>(() => {
    if (!f) return [];
    const hist: Point[] = f.history.slice(-24).map((b) => ({ date: b.date, close: b.close }));
    const last = hist[hist.length - 1];
    Object.assign(last, { p10: last.close, pBand: 0, p50v: last.close });
    const fwd: Point[] = f.forecast.map((p, i) => ({
      date: p.date,
      p10: p.p10,
      pBand: p.p90 - p.p10,
      p50v: i < validH ? p.p50 : undefined,
      p50x: i >= validH - 1 ? p.p50 : undefined,
    }));
    return [...hist, ...fwd];
  }, [f, validH]);

  // Stacked band areas pull the auto domain to zero; scale to the data instead.
  const domain = useMemo<[number, number]>(() => {
    const vals = points.flatMap((p) => [p.close, p.p10, p.p10 !== undefined ? p.p10 + (p.pBand ?? 0) : undefined])
      .filter((v): v is number => v !== undefined);
    return vals.length ? [Math.min(...vals) * 0.95, Math.max(...vals) * 1.03] : [0, 1];
  }, [points]);

  if (state?.id === id && state.error) return <div className="empty fc-error">{state.error}</div>;
  if (!f) return <div className="empty">Loading forecast…</div>;

  const last = f.history[f.history.length - 1];
  const dp = last.close < 10 ? 3 : last.close < 1000 ? 1 : 0;
  const hz = (h: number) => f.horizons[h - 1];
  const fc = (h: number) => f.forecast[h - 1];

  return (
    <div className="chart-wrap">
      <div className="fc-head">
        <div className="fc-id">
          <span className="chart-name">{f.series}</span>
          <span className="chart-unit">World Bank monthly avg · {f.unit}</span>
        </div>
        <dl className="chart-stats">
          <div><dt>{last.date} Actual</dt><dd>{fmt(last.close, dp)}</dd></div>
          {[1, 3].map((h) => (
            <div key={h}>
              <dt>{fc(h).date} P50</dt>
              <dd className={dirClass(fc(h).p50 - last.close)}>
                {fmt(fc(h).p50, dp)} <span className="sub">{pct(fc(h).p50 / last.close - 1)}</span>
              </dd>
            </div>
          ))}
          <div>
            <dt>{fc(3).date} P10–P90</dt>
            <dd>{fmt(fc(3).p10, dp)}–{fmt(fc(3).p90, dp)}</dd>
          </div>
        </dl>
      </div>
      <div className="fc-skill" title={`Out-of-sample test ${f.testPeriod}. Pass = ${f.criteria}.`}>
        <span className="sub">Tested {f.testPeriod} · skill vs no-change</span>
        {[1, 3, 6, 12].map((h) => (
          <span key={h} className={hz(h).pass ? 'up' : 'flat'}>
            {h}M {hz(h).skill > 0 ? '+' : ''}{hz(h).skill}% {hz(h).pass ? '✓' : '✗'}
          </span>
        ))}
        <span className="sub">this series 1M: {hz(1).perCommodity[id] > 0 ? '+' : ''}{hz(1).perCommodity[id]}%</span>
      </div>
      <div className="chart-area">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="fc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.line} stopOpacity={0.25} />
                <stop offset="100%" stopColor={C.line} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: C.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={36} />
            <YAxis
              orientation="right"
              domain={domain}
              allowDataOverflow
              tick={{ fill: C.axis, fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v: number) => fmt(v, dp)}
            />
            <Tooltip
              contentStyle={{ background: C.tipBg, border: `1px solid ${C.tipLine}`, fontSize: 11, fontFamily: 'IBM Plex Mono, monospace' }}
              labelStyle={{ color: C.axis }}
              formatter={(v: number, name: string, item: { payload?: Point }) =>
                name === 'pBand'
                  ? [fmt((item.payload?.p10 ?? 0) + v, dp), 'P90']
                  : [fmt(v, dp), LABELS[name] ?? name]
              }
            />
            <Area type="linear" dataKey="close" stroke={C.line} strokeWidth={1.5} fill="url(#fc-fill)" isAnimationActive={false} dot={false} />
            <Area type="monotone" dataKey="p10" stackId="ci" stroke="none" fill="transparent" isAnimationActive={false} dot={false} />
            <Area type="monotone" dataKey="pBand" stackId="ci" stroke="none" fill={C.band} isAnimationActive={false} dot={false} />
            <Line type="monotone" dataKey="p50v" stroke={C.p50} strokeWidth={1.75} dot={{ r: 2, fill: C.p50 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="p50x" stroke={C.ext} strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <ReferenceLine x={last.date} stroke={C.axis} strokeDasharray="3 3" label={{ value: 'LAST ACTUAL', position: 'insideTopLeft', fill: C.axis, fontSize: 10 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-legend">
        <span><i style={{ background: C.line }} />Actual</span>
        <span><i style={{ background: C.p50 }} />P50 · validated 1–{validH}M</span>
        <span><i style={{ background: C.ext }} />P50 &gt;{validH}M · no edge over no-change</span>
        <span><i style={{ background: C.band }} />P10–P90</span>
        <span>{f.model}</span>
      </div>
    </div>
  );
}
