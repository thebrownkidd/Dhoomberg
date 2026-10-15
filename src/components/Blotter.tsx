import { useState } from 'react';
import type { Account, Approval, Connection, OrderRecord, Position } from '../../shared/types';
import { api, useHealth, useServerData } from '../lib/server';
import { dirClass, fmt } from './format';

type Book = { connectionId: string; name: string; mode: 'paper' | 'live'; armed: boolean; account: Account | null; positions: Position[]; error: string | null };
type Tab = 'approvals' | 'positions' | 'orders' | 'ticket';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function Blotter({ selected, onSettings }: { selected: string; onSettings: () => void }) {
  const health = useHealth();
  const approvals = useServerData(() => api.get<Approval[]>('/approvals'), ['approvals']);
  const orders = useServerData(() => api.get<OrderRecord[]>('/orders?limit=100'), ['orders']);
  const book = useServerData(() => api.get<Book[]>('/portfolio'), ['orders', 'connections']);
  const pending = (approvals.data ?? []).filter((a) => a.status === 'pending');
  const [tab, setTab] = useState<Tab>('approvals');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (health === null) {
    return (
      <div className="bl-offline">
        Orders, approvals and positions live on the local server.<br />Run <code>npm start</code>, then connect the built-in Paper broker in <button className="link" onClick={onSettings}>Settings → Brokers</button>.
      </div>
    );
  }

  async function decide(a: Approval, ok: boolean) {
    try {
      if (ok) {
        const r = await api.post<{ order: OrderRecord }>(`/approvals/${a.id}/approve`);
        setMsg({ ok: r.order.status !== 'rejected', text: r.order.status === 'rejected' ? `Guard rejected: ${r.order.reason}` : `Order ${r.order.status}` });
      } else {
        await api.post(`/approvals/${a.id}/reject`);
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  return (
    <div className="bl">
      <div className="choke-tabs bl-tabs">
        {(['approvals', 'positions', 'orders', 'ticket'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'approvals' ? `APPROVALS${pending.length ? ` (${pending.length})` : ''}` : t.toUpperCase()}
          </button>
        ))}
        <span className="choke-tab-meta">
          {health?.halted
            ? <button className="bl-halt on" onClick={() => api.post('/resume')}>HALTED · RESUME</button>
            : <button className="bl-halt" onClick={() => api.post('/halt', { reason: 'Blotter HALT button' })}>HALT</button>}
        </span>
      </div>
      {msg && <div className={`bl-msg ${msg.ok ? 'up' : 'down'}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      {tab === 'approvals' && (
        <div className="bl-body">
          {!pending.length && <div className="empty">No orders waiting. Rules in <b>confirm</b> mode put orders here; type <code>APPROVE &lt;id&gt;</code> or click.</div>}
          {pending.map((a) => (
            <div key={a.id} className="bl-apv">
              <div>
                <div><b className={a.intent.side === 'buy' ? 'up' : 'down'}>{a.intent.side.toUpperCase()}</b> {a.intent.qty} {a.intent.instrument} {a.intent.orderType === 'limit' ? `LMT ${a.intent.limitPrice}` : 'MKT'} <span className="sub">ref {a.refPrice}</span></div>
                <div className="sub">{a.ruleName} · {time(a.createdAt)} · {a.id}</div>
              </div>
              <div className="bl-apv-btns">
                <button className="primary" onClick={() => decide(a, true)}>Approve</button>
                <button onClick={() => decide(a, false)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'positions' && (
        <div className="bl-body">
          {!book.data?.length && <div className="empty">No broker connected. <button className="link" onClick={onSettings}>Connect Paper trading</button></div>}
          {book.data?.map((b) => (
            <div key={b.connectionId} className="bl-book">
              <div className="bl-book-head">
                <span className={`st-badge ${b.mode === 'live' ? 'danger' : ''}`}>{b.mode === 'live' ? (b.armed ? 'LIVE' : 'LIVE · NOT ARMED') : 'PAPER'}</span>
                <b>{b.name}</b>
                {b.account && <span className="sub">equity {b.account.equity === null ? 'n/a' : fmt(b.account.equity, 0)} · cash {b.account.cash === null ? 'n/a' : fmt(b.account.cash, 0)} {b.account.currency}</span>}
                {b.error && <span className="down">{b.error}</span>}
              </div>
              {b.positions.length > 0 && (
                <table className="t">
                  <thead><tr><th className="l">Instrument</th><th>Qty</th><th>Avg</th><th>Mkt</th><th>Unreal. P&amp;L</th></tr></thead>
                  <tbody>
                    {b.positions.map((p) => (
                      <tr key={p.instrument}>
                        <td className="l"><span className="tk">{p.instrument}</span></td>
                        <td className={dirClass(p.qty)}>{p.qty}</td>
                        <td>{fmt(p.avgPrice, 3)}</td>
                        <td>{p.marketPrice === null ? '—' : fmt(p.marketPrice, 3)}</td>
                        <td className={p.unrealizedPnl === null ? '' : dirClass(p.unrealizedPnl)}>{p.unrealizedPnl === null ? '—' : fmt(p.unrealizedPnl, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'orders' && (
        <div className="bl-body">
          <table className="t">
            <thead><tr><th className="l">Time</th><th className="l">Order</th><th className="l">Status</th><th>Fill</th></tr></thead>
            <tbody>
              {orders.data?.map((o) => (
                <tr key={o.id} title={o.reason ?? ''}>
                  <td className="l">{time(o.createdAt)}</td>
                  <td className="l"><span className={`st-badge ${o.mode === 'live' ? 'danger' : ''}`}>{o.mode === 'live' ? 'L' : 'P'}</span> <b className={o.side === 'buy' ? 'up' : 'down'}>{o.side.toUpperCase()}</b> {o.qty} {o.instrument}{o.orderType === 'limit' ? ` @${o.limitPrice}` : ''}</td>
                  <td className="l">
                    <span className={o.status === 'filled' ? 'up' : o.status === 'rejected' || o.status === 'error' ? 'down' : 'warn'}>{o.status}</span>
                    {o.reason && <div className="bl-reason">{o.reason}</div>}
                  </td>
                  <td>{o.fillPrice ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!orders.data?.length && <div className="empty">No orders yet.</div>}
        </div>
      )}

      {tab === 'ticket' && <Ticket selected={selected} onResult={(o) => { setMsg({ ok: o.status !== 'rejected' && o.status !== 'error', text: o.status === 'rejected' || o.status === 'error' ? `${o.status}: ${o.reason}` : `Order ${o.status}${o.fillPrice ? ` @ ${o.fillPrice}` : ''}` }); setTab('orders'); }} />}
    </div>
  );
}

function Ticket({ selected, onResult }: { selected: string; onResult: (o: OrderRecord) => void }) {
  const brokers = useServerData(() => Promise.all([api.get<Connection[]>('/connections?kind=broker')]).then(([b]) => b.filter((c) => c.enabled)), ['connections']);
  const [t, setT] = useState({ connectionId: '', instrument: selected, side: 'buy' as 'buy' | 'sell', qty: 1, orderType: 'market' as 'market' | 'limit', limitPrice: '', tif: 'day' as 'day' | 'gtc' | 'ioc', symbol: '' });
  const [busy, setBusy] = useState(false);
  const conn = t.connectionId || brokers.data?.[0]?.id || '';
  async function submit() {
    setBusy(true);
    try {
      const o = await api.post<OrderRecord>('/orders', { ...t, connectionId: conn, instrument: t.instrument.toUpperCase(), limitPrice: t.orderType === 'limit' ? Number(t.limitPrice) : undefined, symbol: t.symbol || undefined });
      onResult(o);
    } catch (e) {
      onResult({ status: 'error', reason: (e as Error).message } as OrderRecord);
    } finally {
      setBusy(false);
    }
  }
  if (!brokers.data?.length) return <div className="empty">Connect a broker first (Settings → Brokers &amp; Risk → Paper trading).</div>;
  return (
    <div className="bl-ticket">
      <select value={conn} onChange={(e) => setT({ ...t, connectionId: e.target.value })}>{brokers.data.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      <div className="bl-sides">
        <button className={t.side === 'buy' ? 'on buy' : ''} onClick={() => setT({ ...t, side: 'buy' })}>BUY</button>
        <button className={t.side === 'sell' ? 'on sell' : ''} onClick={() => setT({ ...t, side: 'sell' })}>SELL</button>
      </div>
      <input type="number" min={0} step="any" value={t.qty} onChange={(e) => setT({ ...t, qty: Number(e.target.value) })} title="Quantity" />
      <input value={t.instrument} onChange={(e) => setT({ ...t, instrument: e.target.value.toUpperCase() })} title="Instrument" />
      <select value={t.orderType} onChange={(e) => setT({ ...t, orderType: e.target.value as 'market' | 'limit' })}><option value="market">MKT</option><option value="limit">LMT</option></select>
      {t.orderType === 'limit' && <input type="number" step="any" placeholder="limit" value={t.limitPrice} onChange={(e) => setT({ ...t, limitPrice: e.target.value })} />}
      <select value={t.tif} onChange={(e) => setT({ ...t, tif: e.target.value as 'day' | 'gtc' | 'ioc' })}><option value="day">DAY</option><option value="gtc">GTC</option><option value="ioc">IOC</option></select>
      <input placeholder="broker symbol (opt.)" value={t.symbol} onChange={(e) => setT({ ...t, symbol: e.target.value })} />
      <button className={`primary ${t.side}`} disabled={busy} onClick={submit}>{busy ? '…' : `${t.side.toUpperCase()} ${t.qty} ${t.instrument}`}</button>
      <div className="sub bl-ticket-note">Passes the same risk guard as rule orders.</div>
    </div>
  );
}
