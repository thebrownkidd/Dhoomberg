import { useEffect, useState } from 'react';
import { getDemandData, type DemandData, type DemandSeries, type CotRecord, type DemandAlert } from '../data/api';
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

type Tab = 'macro' | 'food' | 'energy' | 'positioning';

const TABS: { id: Tab; label: string }[] = [
  { id: 'macro',       label: 'MACRO' },
  { id: 'food',        label: 'FOOD' },
  { id: 'energy',      label: 'ENERGY' },
  { id: 'positioning', label: 'POSITIONING' },
];

function pct(val: number) { return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`; }
function fmt2(v: number) { return v.toFixed(2); }

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({ data, refLine, color = 'var(--amber)' }: {
  data: { date: string; value: number }[];
  refLine?: number;
  color?: string;
}) {
  const vals = data.map((d) => d.value);
  const mn = Math.min(...vals) * 0.995;
  const mx = Math.max(...vals) * 1.005;
  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={data}>
        <XAxis dataKey="date" hide />
        <YAxis domain={[mn, mx]} hide />
        <Tooltip
          contentStyle={{ background: 'var(--bg)', border: '1px solid var(--line)', fontSize: 11 }}
          formatter={(v: number) => [v.toFixed(2), '']}
          labelStyle={{ color: 'var(--dim)' }}
        />
        {refLine !== undefined && (
          <ReferenceLine y={refLine} stroke="var(--faint)" strokeDasharray="3 3" />
        )}
        <Line type="monotone" dataKey="value" dot={false} stroke={color} strokeWidth={1.5} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Series tile ────────────────────────────────────────────────────────────────
function SeriesTile({ s, id }: { s: DemandSeries; id: string }) {
  const isPMI = id === 'NAPM';
  const momPct = s.latest ? (s.mom / (s.latest - s.mom)) * 100 : 0;
  const yoyPct = s.latest ? (s.yoy / (s.latest - s.yoy)) * 100 : 0;
  const up = s.mom >= 0;
  const color = isPMI
    ? s.expanding ? 'var(--up)' : 'var(--down)'
    : up ? 'var(--up)' : 'var(--down)';

  return (
    <div className="demand-tile">
      <div className="demand-tile-header">
        <span className="demand-tile-name">{s.name}</span>
        <span className="demand-tile-source">{s.source}</span>
      </div>
      <div className="demand-tile-body">
        <span className="demand-tile-value" style={{ color }}>{fmt2(s.latest)}</span>
        {isPMI && (
          <span className="demand-tile-badge" style={{ color }}>
            {s.expanding ? 'EXPANDING' : 'CONTRACTING'}
            {s.streak ? ` ${s.streak}mo` : ''}
          </span>
        )}
        <span className="demand-tile-change" style={{ color: up ? 'var(--up)' : 'var(--down)' }}>
          {up ? '▲' : '▼'} MoM {pct(momPct)} · YoY {pct(yoyPct)}
        </span>
      </div>
      <Sparkline data={s.history} refLine={isPMI ? 50 : undefined} color={color} />
      <div className="demand-tile-unit">{s.unit} · through {s.latestDate}</div>
    </div>
  );
}

// ── COT row ───────────────────────────────────────────────────────────────────
function CotRow({ rec }: { cid: string; rec: CotRecord }) {
  const pct = rec.netLongPct;
  const crowded = rec.crowdedLong || rec.crowdedShort;
  const color = pct >= 0 ? 'var(--green)' : 'var(--red)';
  const barWidth = Math.min(Math.abs(pct) / 20 * 100, 100);
  const weekUp = rec.weekChange >= 0;

  return (
    <tr className={crowded ? 'cot-row crowded' : 'cot-row'}>
      <td className="cot-name">
        {rec.name}
        {crowded && <span className="cot-crowded-badge">{pct >= 0 ? 'CROWDED↑' : 'CROWDED↓'}</span>}
      </td>
      <td className="cot-net" style={{ color }}>
        {rec.netLong >= 0 ? '+' : ''}{(rec.netLong / 1000).toFixed(0)}k
      </td>
      <td className="cot-pct" style={{ color }}>
        <div className="cot-bar-wrap">
          <div className="cot-bar" style={{ width: `${barWidth}%`, background: color, opacity: 0.7 }} />
          <span>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</span>
        </div>
      </td>
      <td className="cot-chg" style={{ color: weekUp ? 'var(--green)' : 'var(--red)' }}>
        {weekUp ? '+' : ''}{(rec.weekChange / 1000).toFixed(0)}k
      </td>
    </tr>
  );
}

// ── Alert row ─────────────────────────────────────────────────────────────────
function AlertRow({ a }: { a: DemandAlert }) {
  const col = a.severity === 'RED' ? 'var(--red)' : a.severity === 'AMBER' ? 'var(--amber)' : 'var(--green)';
  return (
    <div className="demand-alert-row">
      <span className="demand-alert-badge" style={{ color: col, borderColor: col }}>{a.severity}</span>
      <div className="demand-alert-body">
        <div className="demand-alert-title" style={{ color: col }}>{a.title}</div>
        <div className="demand-alert-msg">{a.message}</div>
        {a.commodities.length > 0 && (
          <div className="demand-alert-cmods">{a.commodities.join(' · ')}</div>
        )}
      </div>
    </div>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function MacroTab({ data }: { data: DemandData }) {
  const { series, alerts } = data;
  const napm = series['NAPM'];
  const indpro = series['INDPRO'];
  const umcsent = series['UMCSENT'];
  const oecd = series['OECD_CLI'];

  const demandAlerts = alerts.filter((a) => ['PMI_CONTRACTION', 'INDPRO_WEAK', 'CONSUMER_SENTIMENT_DROP'].includes(a.type));

  return (
    <div className="demand-tab-content">
      {demandAlerts.length > 0 && (
        <div className="demand-alerts-section">
          {demandAlerts.map((a) => <AlertRow key={a.id} a={a} />)}
        </div>
      )}
      <div className="demand-tiles">
        {napm   && <SeriesTile s={napm}   id="NAPM" />}
        {indpro && <SeriesTile s={indpro} id="INDPRO" />}
        {umcsent && <SeriesTile s={umcsent} id="UMCSENT" />}
        {oecd   && <SeriesTile s={oecd}   id="OECD_CLI" />}
      </div>
      {!napm && !indpro && (
        <div className="empty demand-empty">
          No macro data. Run <code>python research/fetch_demand.py</code> then <code>python research/ml_demand.py</code>.
        </div>
      )}
    </div>
  );
}

function FoodTab({ data }: { data: DemandData }) {
  const { series, alerts } = data;
  const fao = series['FAO_FFPI'];
  const foodAlerts = alerts.filter((a) => a.type === 'FAO_FOOD_PRICE_SPIKE');

  return (
    <div className="demand-tab-content">
      {foodAlerts.length > 0 && (
        <div className="demand-alerts-section">
          {foodAlerts.map((a) => <AlertRow key={a.id} a={a} />)}
        </div>
      )}
      {fao ? (
        <div className="demand-tiles">
          <SeriesTile s={fao} id="FAO_FFPI" />
        </div>
      ) : (
        <div className="empty demand-empty">
          No FAO data. Run <code>python research/fetch_demand.py</code> then <code>python research/ml_demand.py</code>.
        </div>
      )}
      <div className="demand-food-note">
        FAO Food Price Index covers cereals, vegetable oils, dairy, meat, and sugar. Index base = 2014–2016 = 100.
        Sourced from UN FAO monthly release.
      </div>
    </div>
  );
}

function EnergyTab({ data }: { data: DemandData }) {
  const { series } = data;
  const wtis = series['WTISTUS'];

  return (
    <div className="demand-tab-content">
      {wtis ? (
        <>
          <div className="demand-eia-header">
            <div className="demand-eia-kv">
              <span className="demand-eia-k">US Crude Inventories</span>
              <span className="demand-eia-v">{(wtis.latest / 1000).toFixed(1)}M bbl</span>
            </div>
            <div className="demand-eia-kv">
              <span className="demand-eia-k">Weekly Change</span>
              <span className="demand-eia-v" style={{ color: (wtis.weekChange ?? 0) < 0 ? 'var(--green)' : 'var(--red)' }}>
                {wtis.weekChange !== undefined
                  ? `${(wtis.weekChange ?? 0) < 0 ? '▼' : '▲'} ${Math.abs((wtis.weekChange ?? 0) / 1000).toFixed(1)}M bbl`
                  : '—'}
              </span>
            </div>
            <div className="demand-eia-kv">
              <span className="demand-eia-k">Signal</span>
              <span className="demand-eia-v"
                style={{ color: wtis.direction === 'draw' ? 'var(--green)' : 'var(--amber)' }}>
                {wtis.direction === 'draw' ? 'DEMAND > SUPPLY' : 'SUPPLY > DEMAND'}
              </span>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <Sparkline data={wtis.history} color="var(--amber)" />
          </div>
          <div className="demand-tile-unit" style={{ marginTop: 4 }}>
            {wtis.unit} · through {wtis.latestDate} · Source: {wtis.source}
          </div>
          <div className="demand-food-note" style={{ marginTop: 12 }}>
            EIA weekly crude inventories. Consecutive draws (inventory falling) indicate demand exceeding supply — a bullish
            signal for WTI, Brent, and Dubai benchmarks. Builds indicate the reverse.
          </div>
        </>
      ) : (
        <div className="empty demand-empty">
          No EIA inventory data. Run <code>python research/fetch_demand.py</code> then <code>python research/ml_demand.py</code>.
        </div>
      )}
    </div>
  );
}

function PositioningTab({ data }: { data: DemandData }) {
  const { cot, alerts } = data;
  const cotAlerts = alerts.filter((a) => ['COT_CROWDED_LONG', 'COT_CROWDED_SHORT'].includes(a.type));
  const sorted = Object.entries(cot).sort((a, b) => Math.abs(b[1].netLongPct) - Math.abs(a[1].netLongPct));

  return (
    <div className="demand-tab-content">
      {cotAlerts.length > 0 && (
        <div className="demand-alerts-section">
          {cotAlerts.map((a) => <AlertRow key={a.id} a={a} />)}
        </div>
      )}
      {sorted.length > 0 ? (
        <div className="cot-table-wrap">
          <table className="cot-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Net Managed Long</th>
                <th>% of OI</th>
                <th>WoW Δ</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(([cid, rec]) => <CotRow key={cid} cid={cid} rec={rec} />)}
            </tbody>
          </table>
          <div className="demand-food-note" style={{ marginTop: 8 }}>
            CFTC Commitment of Traders (disaggregated, futures-only). Managed money = hedge funds, CTAs, commodity pools.
            Crowded = net long/short &gt; 15% of open interest. Source: CFTC weekly release.
          </div>
        </div>
      ) : (
        <div className="empty demand-empty">
          No COT data. Run <code>python research/fetch_cot.py</code> then <code>python research/ml_demand.py</code>.
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function DemandPanel() {
  const [tab, setTab] = useState<Tab>('macro');
  const [data, setData] = useState<DemandData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getDemandData()
      .then(setData)
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="empty" style={{ color: 'var(--red)', padding: 12 }}>{err}</div>;
  if (!data) return <div className="empty">Loading demand data…</div>;

  const totalAlerts = data.alerts.length;
  const cotCrowded = Object.values(data.cot).filter((r) => r.crowdedLong || r.crowdedShort).length;

  return (
    <>
      <div className="choke-tabs" style={{ position: 'sticky', top: 0, zIndex: 2 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`choke-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'macro' && totalAlerts > 0 && (
              <span className="choke-tab-badge">{totalAlerts}</span>
            )}
            {t.id === 'positioning' && cotCrowded > 0 && (
              <span className="choke-tab-badge">{cotCrowded}</span>
            )}
          </button>
        ))}
        <span className="demand-as-of">as of {data.asOf}</span>
      </div>

      <div>
        {tab === 'macro'       && <MacroTab       data={data} />}
        {tab === 'food'        && <FoodTab        data={data} />}
        {tab === 'energy'      && <EnergyTab      data={data} />}
        {tab === 'positioning' && <PositioningTab data={data} />}
      </div>
    </>
  );
}
