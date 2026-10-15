import { useEffect, useState } from 'react';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../../../shared/types';
import { api, useHealth } from '../../lib/server';
import Connections from './Connections';

const LIMITS: { key: keyof RiskLimits; label: string; unit: string; help: string }[] = [
  { key: 'maxOrderNotional', label: 'Max order notional', unit: 'USD', help: 'qty × price × multiplier, per order' },
  { key: 'maxDailyNotional', label: 'Max daily notional', unit: 'USD', help: 'Sum of all orders since 00:00 UTC' },
  { key: 'maxOrdersPerDay', label: 'Max orders per day', unit: 'orders', help: 'Across every broker' },
  { key: 'maxPositionNotional', label: 'Max position per instrument', unit: 'USD', help: 'Only blocks orders that increase exposure' },
  { key: 'maxLimitDeviationPct', label: 'Limit price band', unit: '% from last', help: 'Fat-finger protection' },
  { key: 'maxQuoteAgeSec', label: 'Max quote age', unit: 'seconds', help: 'No orders on stale prices' },
  { key: 'approvalTtlMin', label: 'Approval expiry', unit: 'minutes', help: 'Unapproved orders expire' },
];

export default function Brokers() {
  const health = useHealth();
  const [limits, setLimits] = useState<RiskLimits | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { api.get<RiskLimits>('/risk').then(setLimits).catch((e) => setMsg({ ok: false, text: e.message })); }, []);

  async function saveLimits() {
    try {
      setLimits(await api.put<RiskLimits>('/risk', limits));
      setMsg({ ok: true, text: 'Risk limits saved (audited).' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  async function arm(id: string, name: string) {
    const acct = window.prompt(`ARM LIVE TRADING on "${name}".\n\nReal money. Orders still pass every risk limit.\nType the broker account ID exactly to confirm:`);
    if (!acct) return;
    try {
      await api.post(`/brokers/${id}/arm`, { accountId: acct });
      setMsg({ ok: true, text: `${name} is armed for live trading.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  const halted = health?.halted;

  return (
    <div>
      <div className={`st-halt ${halted ? 'on' : ''}`}>
        <div>
          <div className="st-halt-title">{halted ? 'TRADING HALTED' : 'Kill switch'}</div>
          <div className="st-small">{halted ? 'All orders are rejected. Open orders were cancelled and pending approvals rejected.' : 'HALT cancels open orders at every broker, rejects pending approvals and blocks new orders.'}</div>
        </div>
        {halted
          ? <button onClick={() => api.post('/resume')}>RESUME</button>
          : <button className="danger big" onClick={() => api.post('/halt', { reason: 'Settings kill switch' })}>HALT ALL TRADING</button>}
      </div>

      {msg && <div className={msg.ok ? 'st-ok' : 'st-error'}>{msg.text}</div>}

      <h3 className="st-h">Risk limits</h3>
      <p className="st-intro">Every order (manual, approved, or auto) passes these checks against a fresh quote. They apply to paper too, so paper behaves like live.</p>
      {limits && (
        <div className="st-limits">
          {LIMITS.map((l) => (
            <div key={l.key} className="sf-row">
              <label className="sf-label">{l.label}<span className="sub"> ({l.unit})</span></label>
              <div className="sf-input">
                <input type="number" min={0} step="any" value={limits[l.key]} onChange={(e) => setLimits({ ...limits, [l.key]: Number(e.target.value) })} />
                <div className="sf-help">{l.help}. Default {DEFAULT_RISK_LIMITS[l.key].toLocaleString('en-US')}.</div>
              </div>
            </div>
          ))}
          <div className="st-editor-foot"><button className="primary" onClick={saveLimits}>Save limits</button></div>
        </div>
      )}

      <h3 className="st-h">Brokers</h3>
      <Connections
        kind="broker"
        intro="Every broker starts on its paper/demo environment. To trade real money: set the environment to live, enable 'allow auto' only if you want unattended orders, then arm it here by retyping the account ID. Live orders also require a real-time data source on the instrument."
        renderExtra={(c) => {
          const h = health?.connections.find((x) => x.id === c.id);
          const env = String(c.config.environment ?? 'paper');
          const isLive = env === 'live';
          return (
            <div className="st-broker-state">
              <span className={`st-badge ${isLive ? (h?.live ? 'danger' : 'warn') : ''}`}>{isLive ? (h?.live ? 'LIVE · ARMED' : 'LIVE · NOT ARMED') : env.toUpperCase()}</span>
              {c.config.allowAuto ? <span className="st-badge warn">auto allowed</span> : <span className="st-badge">confirm only</span>}
              {isLive && !h?.live && <button className="link danger" onClick={() => arm(c.id, c.name)}>Arm live trading…</button>}
              {isLive && h?.live && <button className="link" onClick={() => api.post(`/brokers/${c.id}/disarm`)}>Disarm</button>}
            </div>
          );
        }}
      />
    </div>
  );
}
