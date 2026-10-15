import { useEffect, useState } from 'react';
import { getChokeML, getSuppliers, type ChokeData } from '../data/api';
import SupplierRisk from './SupplierRisk';
import { fmt } from './format';

type Tab = 'CORRIDORS' | 'SUPPLIERS';

function Pips({ level }: { level: number }) {
  return (
    <span className={`pips lvl-${level}`} aria-label={`Threat level ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= level ? 'on' : undefined} />
      ))}
    </span>
  );
}

function CorridorTable({ points }: { points: Record<string, ChokeData> }) {
  return (
    <table className="t choke">
      <thead>
        <tr>
          <th className="l">Corridor</th>
          <th>Threat</th>
          <th title="Transit index vs avg">Transit</th>
          <th title="Vessel flow vs avg">Flow</th>
          <th>Queue</th>
          <th title="Extra cost/days if rerouted">Reroute</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(points).map(([id, p]) => {
          const flowDelta = p.vesselFlowVsAvg - 1;
          return (
            <tr key={id} title={`Advisory: ${p.advisory} · Driver: ${p.primaryDriver}`}>
              <td className="l">
                <div className="cp-name">{p.name}</div>
                <div className="cp-sub">{p.lastIncident !== 'N/A' ? `Last: ${p.lastIncident}` : p.transitVolume}</div>
              </td>
              <td>
                <Pips level={p.threatLevel} />
                <span className="sub" style={{ marginLeft: 4 }}>{p.threatScore.toFixed(1)}</span>
              </td>
              <td className={p.transitIndexVsAvg > 1.1 ? 'warn' : undefined}>
                {p.transitIndexVsAvg.toFixed(2)}×
              </td>
              <td className={flowDelta < -0.15 ? 'down' : flowDelta > 0.15 ? 'warn' : undefined}>
                {(p.vesselFlowVsAvg * 100).toFixed(0)}%
              </td>
              <td className={p.queueVessels >= 20 ? 'warn' : undefined}>{p.queueVessels}</td>
              <td>
                {p.rerouteUsdTeu !== null ? (
                  <>
                    +${fmt(p.rerouteUsdTeu, 0)}
                    {p.rerouteDays !== null && <span className="sub"> +{p.rerouteDays}d</span>}
                  </>
                ) : (
                  <span className="sub">n/a</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ChokepointBoard() {
  const [tab, setTab] = useState<Tab>('CORRIDORS');
  const [chokes, setChokes] = useState<Record<string, ChokeData> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pre-warm supplier data
    getSuppliers().catch(() => {});
    getChokeML()
      .then(setChokes)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <div className="choke-tabs" style={{ position: 'sticky', top: 0, zIndex: 2 }}>
        {(['CORRIDORS', 'SUPPLIERS'] as Tab[]).map((t) => (
          <button key={t} type="button" className={t === tab ? 'on' : undefined} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        {chokes && tab === 'CORRIDORS' && (
          <span className="choke-tab-meta sub">
            ML-06 · {Object.values(chokes).filter((c) => c.threatLevel >= 4).length} corridors L4+
          </span>
        )}
      </div>
      <div>
        {tab === 'CORRIDORS' ? (
          error ? (
            <div className="empty fc-error">{error}</div>
          ) : !chokes ? (
            <div className="empty">Loading corridors…</div>
          ) : (
            <CorridorTable points={chokes} />
          )
        ) : (
          <SupplierRisk />
        )}
      </div>
    </>
  );
}
