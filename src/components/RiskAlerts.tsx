import { useEffect, useState } from 'react';
import { getLanes, type Lane } from '../data/api';

function band(score: number): 'red' | 'amber' | 'green' {
  return score > 70 ? 'red' : score >= 40 ? 'amber' : 'green';
}

const TREND_ICON: Record<string, string> = { deteriorating: '▲', stable: '▶', improving: '▼' };
const TREND_CLASS: Record<string, string> = { deteriorating: 't-up', stable: 't-flat', improving: 't-down' };

const ACTION_LABEL: Record<string, string> = {
  ADD_COVER: 'ADD COVER',
  MONITOR: 'MONITOR',
  REDUCE_COVER: 'REDUCE COVER',
};

export default function RiskAlerts() {
  const [state, setState] = useState<{ lanes?: Lane[]; meta?: { ml05Note: string }; error?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getLanes()
      .then(({ meta, lanes }) => alive && setState({ lanes, meta }))
      .catch((e: Error) => alive && setState({ error: e.message }));
    return () => { alive = false; };
  }, []);

  if (state?.error) return <div className="empty fc-error">{state.error}</div>;
  if (!state?.lanes) return <div className="empty">Loading lane risk…</div>;

  const { lanes, meta } = state;

  return (
    <>
      <table className="t risk">
        <thead>
          <tr>
            <th className="l">Score</th>
            <th className="l">Lane</th>
            <th className="l">Top driver</th>
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => {
            const b = band(lane.laneRiskScore);
            const signal = lane.forecastSignal;
            return (
              <tr key={lane.lane} title={`Corridor: ${lane.corridor} · Carrier: ${lane.carrier}`}>
                <td className="l">
                  <span className={`score ${b}`}>{lane.laneRiskScore.toFixed(0)}</span>
                  <span className={`trend ${TREND_CLASS[lane.riskTrend] ?? 't-flat'}`} aria-label={`Trend ${lane.riskTrend}`}>
                    {TREND_ICON[lane.riskTrend] ?? '▶'}
                  </span>
                </td>
                <td className="l">
                  <div className="cp-name" style={{ fontSize: 11 }}>{lane.lane}</div>
                  <div className="cp-sub">{lane.carrier} · {lane.corridor.replace(/_/g, ' ')}</div>
                </td>
                <td className="l wrap">{lane.topDriver.replace(/_/g, ' ')}</td>
                <td className={`sig ${b}`}>
                  {ACTION_LABEL[signal.action] ?? signal.action}
                  {signal.daysToAdd !== 0 && (
                    <span className="sub"> {signal.daysToAdd > 0 ? '+' : ''}{signal.daysToAdd}d</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {meta?.ml05Note && (
        <div className="risk-note sub">{meta.ml05Note}</div>
      )}
    </>
  );
}
