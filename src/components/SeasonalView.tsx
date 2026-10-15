import { useEffect, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getSeasonal, type SeasonalResult } from '../data/api';
import { fmt } from './format';

const C = { line: '#ffa028', trend: '#4fc3f7', grid: '#161c24', axis: '#7d8794', tipBg: '#0d1117', tipLine: '#2a333f' };

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function SeasonalView({ id }: { id: string }) {
  const [state, setState] = useState<{ id: string; data?: SeasonalResult; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getSeasonal(id)
      .then((data) => alive && setState({ id, data }))
      .catch((e: Error) => alive && setState({ id, error: e.message }));
    return () => { alive = false; };
  }, [id]);

  const f = state?.id === id ? state.data : undefined;

  const trendData = useMemo(() => {
    if (!f) return [];
    return f.data.map((d) => ({ date: d.date, original: d.original, trend: d.trend }));
  }, [f]);

  const seasonalBars = useMemo(() => {
    if (!f) return [];
    return Object.entries(f.seasonalPattern).map(([m, val]) => ({
      month: MONTH_NAMES[parseInt(m)],
      effect: parseFloat((val * 100).toFixed(2)),
    }));
  }, [f]);

  const domain = useMemo<[number, number]>(() => {
    if (!trendData.length) return [0, 1];
    const vals = trendData.flatMap((d) => [d.original, d.trend]).filter((v): v is number => v !== undefined);
    return [Math.min(...vals) * 0.94, Math.max(...vals) * 1.04];
  }, [trendData]);

  if (state?.id === id && state.error) return <div className="empty fc-error">{state.error}</div>;
  if (!f) return <div className="empty">Loading decomposition…</div>;

  const strengthLabel = f.noSeasonalPattern
    ? 'No seasonal pattern detected'
    : `Seasonal strength: ${(f.seasonalStrength * 100).toFixed(1)}%`;

  const dp = f.data[0]?.original < 10 ? 3 : f.data[0]?.original < 1000 ? 1 : 0;

  return (
    <div className="chart-wrap">
      <div className="fc-head">
        <div className="fc-id">
          <span className="chart-name">{f.series}</span>
          <span className="chart-unit">{f.unit} · STL decomposition</span>
        </div>
        <dl className="chart-stats">
          <div><dt>Seasonal</dt><dd className={f.noSeasonalPattern ? 'flat' : 'up'}>{strengthLabel}</dd></div>
          {f.residualAutocorr && <div><dt>Residual</dt><dd className="warn">Autocorrelation detected</dd></div>}
          <div><dt>Check</dt><dd className={f.decompositionCheck ? 'up' : 'down'}>{f.decompositionCheck ? 'Trend+seas+resid=orig' : 'Mismatch!'}</dd></div>
        </dl>
      </div>
      <div className="seas-panels">
        <div className="seas-main">
          <div className="seas-label">ORIGINAL + TREND</div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trendData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="date" tick={{ fill: C.axis, fontSize: 9 }} tickLine={false} axisLine={{ stroke: C.grid }} minTickGap={40} />
              <YAxis orientation="right" domain={domain} allowDataOverflow tick={{ fill: C.axis, fontSize: 9 }} tickLine={false} axisLine={false} width={60} tickFormatter={(v: number) => fmt(v, dp)} />
              <Tooltip contentStyle={{ background: C.tipBg, border: `1px solid ${C.tipLine}`, fontSize: 11 }} labelStyle={{ color: C.axis }}
                formatter={(v: number, name: string) => [fmt(v, dp), name === 'trend' ? 'Trend' : 'Original']} />
              <Area type="linear" dataKey="original" stroke={C.line} strokeWidth={1} fill="rgba(255,160,40,0.08)" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="trend" stroke={C.trend} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="seas-side">
          <div className="seas-label">SEASONAL PATTERN (avg log-return)</div>
          <div className="seas-bars">
            {seasonalBars.map(({ month, effect }) => (
              <div key={month} className="seas-bar-row">
                <span className="seas-month">{month}</span>
                <div className="seas-bar-track">
                  <div
                    className={`seas-bar-fill ${effect > 0 ? 'up' : 'down'}`}
                    style={{ width: `${Math.min(Math.abs(effect) * 8, 100)}%`, float: effect > 0 ? 'left' : 'right' }}
                  />
                </div>
                <span className={`seas-val ${effect > 0 ? 'up' : effect < 0 ? 'down' : 'flat'}`}>
                  {effect > 0 ? '+' : ''}{effect.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="chart-legend">
        <span><i style={{ background: C.line }} />Original</span>
        <span><i style={{ background: C.trend }} />Trend (STL)</span>
        <span className="flat">Seasonal: log-return units · data through {f.dataThrough}</span>
        {f.noSeasonalPattern && <span className="warn">These prices are shock-driven, not harvest-seasonal at monthly resolution.</span>}
      </div>
    </div>
  );
}
