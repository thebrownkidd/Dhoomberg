import { useEffect, useState } from 'react';
import { getIndicators, type IndicatorResult, type Indicator } from '../data/api';

function PassBadge({ pass, status }: { pass: boolean; status: string }) {
  if (pass) return <span className="ind-badge pass">PASS</span>;
  if (status === 'MARGINAL') return <span className="ind-badge marginal">MARGINAL</span>;
  return null;
}

function CorrBar({ value, max }: { value: number; max: number }) {
  const w = Math.round(Math.abs(value) / max * 100);
  return (
    <div className="ind-bar-track">
      <div className={`ind-bar-fill ${value >= 0 ? 'up' : 'down'}`} style={{ width: `${w}%` }} />
    </div>
  );
}

function IndicatorRow({ ind, maxCorr }: { ind: Indicator; maxCorr: number }) {
  return (
    <tr className={ind.pass ? 'ind-pass' : undefined} title={ind.description}>
      <td className="l">
        <div>{ind.name}</div>
        <div className="cp-sub">lag {ind.lagMonths}M · {ind.direction}</div>
      </td>
      <td>
        <div className="ind-corr-row">
          <CorrBar value={ind.discoveryCorr} max={maxCorr} />
          <span className={ind.discoveryCorr >= 0 ? 'up' : 'down'}>{ind.discoveryCorr > 0 ? '+' : ''}{ind.discoveryCorr.toFixed(2)}</span>
        </div>
      </td>
      <td>
        <div className="ind-corr-row">
          <CorrBar value={ind.oosCorr} max={maxCorr} />
          <span className={ind.oosCorr >= 0 ? 'up' : 'down'}>{ind.oosCorr > 0 ? '+' : ''}{ind.oosCorr.toFixed(2)}</span>
        </div>
      </td>
      <td className={ind.grangerP < ind.grangerThreshold ? 'up' : 'flat'}>{ind.grangerP.toFixed(3)}</td>
      <td><PassBadge pass={ind.pass} status={ind.status} /></td>
    </tr>
  );
}

export default function IndicatorsView({ id }: { id: string }) {
  const [state, setState] = useState<{ id: string; data?: IndicatorResult; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getIndicators(id)
      .then((data) => alive && setState({ id, data }))
      .catch((e: Error) => alive && setState({ id, error: e.message }));
    return () => { alive = false; };
  }, [id]);

  const f = state?.id === id ? state.data : undefined;

  if (state?.id === id && state.error) return <div className="empty fc-error">{state.error}</div>;
  if (!f) return <div className="empty">Loading indicators…</div>;

  const maxCorr = Math.max(0.01, ...f.indicators.map((i) => Math.abs(i.oosCorr)));
  const bonferroniP = f.bonferroniAlpha.toFixed(4);

  return (
    <div className="chart-wrap">
      <div className="fc-head">
        <div className="fc-id">
          <span className="chart-name">{f.series}</span>
          <span className="chart-unit">Leading indicators · OOS {f.oosPeriod}</span>
        </div>
        <dl className="chart-stats">
          <div><dt>Passing</dt><dd className={f.nPass > 0 ? 'up' : 'flat'}>{f.nPass} of {f.indicators.length} tested</dd></div>
          <div><dt>Granger threshold</dt><dd>p &lt; {bonferroniP} (Bonferroni)</dd></div>
          <div><dt>OOS |r| min</dt><dd>{f.oosCorrMin}</dd></div>
        </dl>
      </div>
      <div className="panel-body" style={{ overflow: 'auto', flex: 1 }}>
        {f.indicators.length === 0 ? (
          <div className="empty">
            No indicators reach even marginal significance (p &lt; 0.10).<br />
            Discovery period: {f.discoveryPeriod}
          </div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th className="l">Indicator</th>
                <th>Disc corr</th>
                <th>OOS corr</th>
                <th>Granger p</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {f.indicators.map((ind) => (
                <IndicatorRow key={`${ind.indicator}-${ind.lagMonths}`} ind={ind} maxCorr={maxCorr} />
              ))}
            </tbody>
          </table>
        )}
        {f.nPass === 0 && f.indicators.length > 0 && (
          <div className="ind-note">
            No indicators pass both Granger causality (p &lt; {bonferroniP}) and OOS correlation (|r| &gt; {f.oosCorrMin}).
            Marginal rows shown for transparency.
          </div>
        )}
      </div>
      <div className="chart-legend">
        <span>Discovery: {f.discoveryPeriod} · OOS confirmation: {f.oosPeriod}</span>
        <span className="flat">Pass = Granger p &lt; {bonferroniP} AND OOS |r| &gt; {f.oosCorrMin}</span>
      </div>
    </div>
  );
}
