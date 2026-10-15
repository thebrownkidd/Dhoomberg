// Brokers. Every broker defaults to its paper/demo environment; switching to live is a
// separate, explicit "arm" step handled by the order executor, never by the config form.
import { kvGet, kvSet, tx } from '../db';
import { getJson, httpFetch, num, postJson } from '../http';
import { need, S, type BrokerImpl, type Ctx, type PluginDef } from './types';

const TIF = { day: 'day', gtc: 'gtc', ioc: 'ioc' } as const;

// ── Paper (internal ledger) ──────────────────────────────────────────────────
function paperCash(ctx: Ctx): number {
  return kvGet(ctx.db, `paper_cash:${ctx.connectionId}`, Number(ctx.config.startingCash ?? 100_000));
}

export function paperFill(ctx: Ctx, instrument: string, symbol: string, side: 'buy' | 'sell', qty: number, price: number, multiplier = 1) {
  tx(ctx.db, () => {
    const row = ctx.db.prepare('SELECT qty, avg_price FROM paper_positions WHERE connection_id = ? AND instrument = ?').get(ctx.connectionId, instrument) as { qty: number; avg_price: number } | undefined;
    const cur = row?.qty ?? 0, avg = row?.avg_price ?? 0;
    const signed = side === 'buy' ? qty : -qty;
    const next = cur + signed;
    let nextAvg = avg;
    if (cur === 0 || Math.sign(cur) === Math.sign(signed)) nextAvg = (Math.abs(cur) * avg + qty * price) / Math.abs(next);
    else if (Math.sign(next) !== Math.sign(cur) && next !== 0) nextAvg = price;     // flipped through zero
    if (next === 0) ctx.db.prepare('DELETE FROM paper_positions WHERE connection_id = ? AND instrument = ?').run(ctx.connectionId, instrument);
    else ctx.db.prepare('INSERT INTO paper_positions (connection_id, instrument, symbol, qty, avg_price) VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id, instrument) DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price')
      .run(ctx.connectionId, instrument, symbol, next, nextAvg);
    kvSet(ctx.db, `paper_cash:${ctx.connectionId}`, paperCash(ctx) - signed * price * multiplier);
  });
}

const paper: BrokerImpl = {
  isLive: () => false,
  accountId: (ctx) => `PAPER-${ctx.connectionId.slice(0, 6)}`,
  async account(ctx) { return { equity: null, cash: paperCash(ctx), currency: 'USD' }; },
  async positions(ctx) {
    return (ctx.db.prepare('SELECT instrument, symbol, qty, avg_price FROM paper_positions WHERE connection_id = ?').all(ctx.connectionId) as { instrument: string; symbol: string; qty: number; avg_price: number }[])
      .map((r) => ({ instrument: r.instrument, symbol: r.symbol, qty: r.qty, avgPrice: r.avg_price, marketPrice: null, unrealizedPnl: null }));
  },
  async placeOrder(_ctx, intent, refPrice) {
    // Market and marketable limits fill immediately at the reference quote; others rest and
    // are swept by the executor on each engine tick.
    const marketable = intent.orderType === 'market' || (intent.side === 'buy' ? intent.limitPrice! >= refPrice : intent.limitPrice! <= refPrice);
    if (!marketable) return { brokerOrderId: null, status: 'open' };
    const px = intent.orderType === 'market' ? refPrice : intent.side === 'buy' ? Math.min(intent.limitPrice!, refPrice) : Math.max(intent.limitPrice!, refPrice);
    return { brokerOrderId: null, status: 'filled', fillPrice: px };
  },
  async cancelAll() { return 0; },
  async test(ctx) { return `Paper account ready, cash $${paperCash(ctx).toLocaleString('en-US')}`; },
};

// ── Alpaca ───────────────────────────────────────────────────────────────────
const alpacaBase = (c: Record<string, any>) => (c.environment === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets');
const alpacaHeaders = (c: Record<string, any>) => ({ 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey });

const alpaca: BrokerImpl = {
  isLive: (ctx) => ctx.config.environment === 'live',
  accountId: (ctx) => String(ctx.config.accountNumber ?? ''),
  async account(ctx) {
    const a = await getJson<{ equity: string; cash: string; currency: string }>(`${alpacaBase(ctx.config)}/v2/account`, { headers: alpacaHeaders(ctx.config) });
    return { equity: num(a.equity), cash: num(a.cash), currency: a.currency };
  },
  async positions(ctx) {
    const ps = await getJson<{ symbol: string; qty: string; avg_entry_price: string; current_price: string; unrealized_pl: string }[]>(`${alpacaBase(ctx.config)}/v2/positions`, { headers: alpacaHeaders(ctx.config) });
    return ps.map((p) => ({ instrument: p.symbol, symbol: p.symbol, qty: num(p.qty), avgPrice: num(p.avg_entry_price), marketPrice: num(p.current_price), unrealizedPnl: num(p.unrealized_pl) }));
  },
  async placeOrder(ctx, o) {
    const r = await postJson<{ id: string; status: string; filled_avg_price: string | null }>(`${alpacaBase(ctx.config)}/v2/orders`, {
      symbol: o.symbol, qty: String(o.qty), side: o.side, type: o.orderType, time_in_force: TIF[o.tif],
      ...(o.orderType === 'limit' ? { limit_price: String(o.limitPrice) } : {}), client_order_id: o.idemKey.slice(0, 128),
    }, { headers: alpacaHeaders(ctx.config) });
    return { brokerOrderId: r.id, status: r.status === 'filled' ? 'filled' : 'submitted', fillPrice: r.filled_avg_price ? num(r.filled_avg_price) : null };
  },
  async cancelAll(ctx) {
    const r = await httpFetch(`${alpacaBase(ctx.config)}/v2/orders`, { method: 'DELETE', headers: alpacaHeaders(ctx.config) });
    const j = (await r.json().catch(() => [])) as unknown[];
    return Array.isArray(j) ? j.length : 0;
  },
  async test(ctx) {
    need(ctx.config, 'keyId', 'secretKey');
    const a = await alpaca.account(ctx);
    return `${ctx.config.environment === 'live' ? 'LIVE' : 'Paper'} account equity ${a.equity} ${a.currency}`;
  },
};

// ── OANDA v20 ────────────────────────────────────────────────────────────────
const oandaBase = (c: Record<string, any>) => (c.environment === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com');
const oandaHeaders = (c: Record<string, any>) => ({ Authorization: `Bearer ${c.apiKey}`, 'Accept-Datetime-Format': 'RFC3339' });

const oanda: BrokerImpl = {
  isLive: (ctx) => ctx.config.environment === 'live',
  accountId: (ctx) => String(ctx.config.accountId ?? ''),
  async account(ctx) {
    const r = await getJson<{ account: { NAV: string; balance: string; currency: string } }>(`${oandaBase(ctx.config)}/v3/accounts/${ctx.config.accountId}/summary`, { headers: oandaHeaders(ctx.config) });
    return { equity: num(r.account.NAV), cash: num(r.account.balance), currency: r.account.currency };
  },
  async positions(ctx) {
    const r = await getJson<{ positions: { instrument: string; long: { units: string; averagePrice?: string }; short: { units: string; averagePrice?: string }; unrealizedPL: string }[] }>(`${oandaBase(ctx.config)}/v3/accounts/${ctx.config.accountId}/openPositions`, { headers: oandaHeaders(ctx.config) });
    return r.positions.map((p) => {
      const qty = num(p.long.units) + num(p.short.units);
      return { instrument: p.instrument, symbol: p.instrument, qty, avgPrice: num((qty >= 0 ? p.long : p.short).averagePrice ?? 'NaN'), marketPrice: null, unrealizedPnl: num(p.unrealizedPL) };
    });
  },
  async placeOrder(ctx, o) {
    const units = String(o.side === 'buy' ? o.qty : -o.qty);
    const order = o.orderType === 'market'
      ? { type: 'MARKET', instrument: o.symbol, units, timeInForce: 'FOK' }
      : { type: 'LIMIT', instrument: o.symbol, units, price: String(o.limitPrice), timeInForce: o.tif === 'gtc' ? 'GTC' : o.tif === 'ioc' ? 'IOC' : 'GFD' };
    const r = await postJson<{ orderCreateTransaction?: { id: string }; orderFillTransaction?: { price: string }; orderCancelTransaction?: { reason: string } }>(
      `${oandaBase(ctx.config)}/v3/accounts/${ctx.config.accountId}/orders`,
      { order: { ...order, clientExtensions: { id: o.idemKey.slice(0, 128), tag: 'dhoomberg' } } }, { headers: oandaHeaders(ctx.config) });
    if (r.orderCancelTransaction) throw new Error(`OANDA cancelled the order: ${r.orderCancelTransaction.reason}`);
    return { brokerOrderId: r.orderCreateTransaction?.id ?? null, status: r.orderFillTransaction ? 'filled' : 'open', fillPrice: r.orderFillTransaction ? num(r.orderFillTransaction.price) : null };
  },
  async cancelAll(ctx) {
    const r = await getJson<{ orders: { id: string }[] }>(`${oandaBase(ctx.config)}/v3/accounts/${ctx.config.accountId}/pendingOrders`, { headers: oandaHeaders(ctx.config) });
    for (const o of r.orders) await httpFetch(`${oandaBase(ctx.config)}/v3/accounts/${ctx.config.accountId}/orders/${o.id}/cancel`, { method: 'PUT', headers: oandaHeaders(ctx.config) });
    return r.orders.length;
  },
  async test(ctx) {
    need(ctx.config, 'apiKey', 'accountId');
    const a = await oanda.account(ctx);
    return `${ctx.config.environment === 'live' ? 'LIVE' : 'Practice'} account NAV ${a.equity} ${a.currency}`;
  },
};

// ── Tradovate (futures) ──────────────────────────────────────────────────────
const tvTokens = new Map<string, { token: string; exp: number }>();
const tvBase = (c: Record<string, any>) => (c.environment === 'live' ? 'https://live.tradovateapi.com/v1' : 'https://demo.tradovateapi.com/v1');

async function tvAuth(ctx: Ctx): Promise<Record<string, string>> {
  const hit = tvTokens.get(ctx.connectionId);
  if (hit && hit.exp > Date.now() + 60_000) return { Authorization: `Bearer ${hit.token}` };
  const c = ctx.config;
  need(c, 'username', 'password', 'cid', 'secret');
  const r = await postJson<{ accessToken?: string; expirationTime?: string; errorText?: string }>(`${tvBase(c)}/auth/accesstokenrequest`, {
    name: c.username, password: c.password, appId: c.appId || 'Dhoomberg', appVersion: '0.2', cid: Number(c.cid), sec: c.secret, deviceId: c.deviceId || `dhoomberg-${ctx.connectionId}`,
  });
  if (!r.accessToken) throw new Error(`Tradovate auth failed: ${r.errorText ?? 'no token'}`);
  tvTokens.set(ctx.connectionId, { token: r.accessToken, exp: Date.parse(r.expirationTime ?? '') || Date.now() + 60 * 60_000 });
  return { Authorization: `Bearer ${r.accessToken}` };
}

async function tvAccount(ctx: Ctx): Promise<{ id: number; name: string }> {
  const list = await getJson<{ id: number; name: string }[]>(`${tvBase(ctx.config)}/account/list`, { headers: await tvAuth(ctx) });
  const acct = ctx.config.accountName ? list.find((a) => a.name === ctx.config.accountName) : list[0];
  if (!acct) throw new Error('No Tradovate account found');
  return acct;
}

const tradovate: BrokerImpl = {
  isLive: (ctx) => ctx.config.environment === 'live',
  accountId: (ctx) => String(ctx.config.accountName ?? ''),
  async account(ctx) {
    const a = await tvAccount(ctx);
    const b = await postJson<{ totalCashValue?: number; netLiq?: number }>(`${tvBase(ctx.config)}/cashBalance/getcashbalancesnapshot`, { accountId: a.id }, { headers: await tvAuth(ctx) });
    return { equity: b.netLiq ?? null, cash: b.totalCashValue ?? null, currency: 'USD' };
  },
  async positions(ctx) {
    const ps = await getJson<{ contractId: number; netPos: number; netPrice: number }[]>(`${tvBase(ctx.config)}/position/list`, { headers: await tvAuth(ctx) });
    return ps.filter((p) => p.netPos !== 0).map((p) => ({ instrument: String(p.contractId), symbol: String(p.contractId), qty: p.netPos, avgPrice: p.netPrice, marketPrice: null, unrealizedPnl: null }));
  },
  async placeOrder(ctx, o) {
    const a = await tvAccount(ctx);
    const r = await postJson<{ orderId?: number; failureReason?: string; failureText?: string }>(`${tvBase(ctx.config)}/order/placeorder`, {
      accountSpec: a.name, accountId: a.id, action: o.side === 'buy' ? 'Buy' : 'Sell', symbol: o.symbol, orderQty: o.qty,
      orderType: o.orderType === 'market' ? 'Market' : 'Limit', ...(o.orderType === 'limit' ? { price: o.limitPrice } : {}),
      timeInForce: o.tif === 'gtc' ? 'GTC' : o.tif === 'ioc' ? 'IOC' : 'Day', isAutomated: true, text: o.idemKey.slice(0, 64),
    }, { headers: await tvAuth(ctx) });
    if (!r.orderId) throw new Error(`Tradovate rejected the order: ${r.failureReason ?? ''} ${r.failureText ?? ''}`.trim());
    return { brokerOrderId: String(r.orderId), status: 'submitted' };
  },
  async cancelAll(ctx) {
    const h = await tvAuth(ctx);
    const os = await getJson<{ id: number; ordStatus: string }[]>(`${tvBase(ctx.config)}/order/list`, { headers: h });
    const working = os.filter((o) => o.ordStatus === 'Working');
    for (const o of working) await postJson(`${tvBase(ctx.config)}/order/cancelorder`, { orderId: o.id }, { headers: h });
    return working.length;
  },
  async test(ctx) {
    const a = await tvAccount(ctx);
    return `${ctx.config.environment === 'live' ? 'LIVE' : 'Demo'} account ${a.name}`;
  },
};

// ── Interactive Brokers (Client Portal Gateway on this machine) ──────────────
const ib = (c: Record<string, any>) => `${String(c.gatewayUrl || 'https://localhost:5000').replace(/\/$/, '')}/v1/api`;

const ibkr: BrokerImpl = {
  isLive: (ctx) => ctx.config.environment === 'live',
  accountId: (ctx) => String(ctx.config.accountId ?? ''),
  async account(ctx) {
    const s = await getJson<Record<string, { amount: number; currency?: string }>>(`${ib(ctx.config)}/portfolio/${ctx.config.accountId}/summary`, { insecureTls: true });
    return { equity: s.netliquidation?.amount ?? null, cash: s.totalcashvalue?.amount ?? null, currency: s.netliquidation?.currency ?? 'USD' };
  },
  async positions(ctx) {
    const ps = await getJson<{ conid: number; contractDesc: string; position: number; avgPrice: number; mktPrice: number; unrealizedPnl: number }[]>(`${ib(ctx.config)}/portfolio/${ctx.config.accountId}/positions/0`, { insecureTls: true });
    return ps.map((p) => ({ instrument: String(p.conid), symbol: p.contractDesc, qty: p.position, avgPrice: p.avgPrice, marketPrice: p.mktPrice, unrealizedPnl: p.unrealizedPnl }));
  },
  async placeOrder(ctx, o) {
    const c = ctx.config;
    type Reply = { order_id?: string; order_status?: string; id?: string; message?: string[]; error?: string }[];
    let r = await postJson<Reply>(`${ib(c)}/iserver/account/${c.accountId}/orders`, {
      orders: [{ conid: Number(o.symbol), orderType: o.orderType === 'market' ? 'MKT' : 'LMT', side: o.side.toUpperCase(), quantity: o.qty, tif: o.tif.toUpperCase(), ...(o.orderType === 'limit' ? { price: o.limitPrice } : {}), cOID: o.idemKey.slice(0, 64) }],
    }, { insecureTls: true });
    // IBKR may answer with warnings that must be confirmed before the order is sent.
    for (let i = 0; i < 3 && r[0]?.id && !r[0]?.order_id; i++) {
      if (!c.autoConfirmWarnings) return { brokerOrderId: null, status: 'needs_confirmation', message: (r[0].message ?? []).join(' ') };
      r = await postJson<Reply>(`${ib(c)}/iserver/reply/${r[0].id}`, { confirmed: true }, { insecureTls: true });
    }
    if (r[0]?.error) throw new Error(`IBKR: ${r[0].error}`);
    if (!r[0]?.order_id) throw new Error(`IBKR: unexpected response ${JSON.stringify(r).slice(0, 200)}`);
    return { brokerOrderId: r[0].order_id, status: r[0].order_status === 'Filled' ? 'filled' : 'submitted' };
  },
  async cancelAll(ctx) {
    const c = ctx.config;
    const r = await getJson<{ orders?: { orderId: number; status: string }[] }>(`${ib(c)}/iserver/account/orders`, { insecureTls: true });
    const open = (r.orders ?? []).filter((o) => ['Submitted', 'PreSubmitted', 'PendingSubmit'].includes(o.status));
    for (const o of open) await httpFetch(`${ib(c)}/iserver/account/${c.accountId}/order/${o.orderId}`, { method: 'DELETE', insecureTls: true });
    return open.length;
  },
  async test(ctx) {
    need(ctx.config, 'accountId');
    const s = await getJson<{ authenticated: boolean }>(`${ib(ctx.config)}/iserver/auth/status`, { method: 'POST', insecureTls: true });
    if (!s.authenticated) throw new Error('Gateway reachable but not logged in. Log in at the gateway URL in your browser.');
    const a = await ibkr.account(ctx);
    return `Gateway authenticated, net liquidation ${a.equity} ${a.currency}`;
  },
};

export const HOURS: Record<string, string> = {
  paper: '24/7',
  alpaca: 'Mon-Fri 09:30-16:00 America/New_York',
  oanda: 'Sun-Thu 17:05-16:59 America/New_York',
  tradovate: 'Sun-Thu 18:00-17:00 America/New_York',
  ibkr: 'Sun-Thu 18:00-17:00 America/New_York',
};

function withCommon(p: PluginDef): PluginDef {
  p.configSchema = {
    ...p.configSchema,
    properties: {
      ...p.configSchema.properties,
      tradingHours: S.str('Trading hours', { default: HOURS[p.id] ?? '24/7', description: 'Orders outside these hours are rejected. "24/7" or e.g. "Mon-Fri 09:30-16:00 America/New_York"; an end before the start crosses midnight.' }),
      allowAuto: S.bool('Allow auto execution', false, { description: 'Off: rules in auto mode are downgraded to confirm (approval needed).' }),
    },
  };
  return p;
}

const ENV = (def = 'paper') => S.oneOf('Environment', ['paper', 'live'], def, { description: 'Live trading also has to be armed separately in Brokers & Risk.' });

const BROKERS: PluginDef[] = [
  {
    id: 'paper', kind: 'broker', name: 'Paper trading (built-in)', category: 'Built-in', source: 'builtin',
    description: 'Simulated fills at the current quote, tracked in a local ledger. No money at risk.',
    configSchema: S.obj({ startingCash: S.num('Starting cash (USD)', 100_000) }), capabilities: { live: false }, impl: paper,
  },
  {
    id: 'alpaca', kind: 'broker', name: 'Alpaca', category: 'Brokers', source: 'builtin', docsUrl: 'https://docs.alpaca.markets/reference/postorder',
    description: 'US stocks/ETFs (incl. commodity ETFs) and crypto. Paper endpoint by default.',
    configSchema: S.obj({ environment: ENV(), keyId: S.str('API key ID'), secretKey: S.secret('API secret key'), accountNumber: S.str('Account number (needed to arm live)') }, ['keyId', 'secretKey']),
    capabilities: { live: true }, impl: alpaca,
  },
  {
    id: 'oanda', kind: 'broker', name: 'OANDA', category: 'Brokers', source: 'builtin', docsUrl: 'https://developer.oanda.com/rest-live-v20/order-ep/',
    description: 'Commodity and FX CFDs (Brent, WTI, gold, corn, wheat, sugar, soybeans, natural gas). Practice account by default.',
    configSchema: S.obj({ environment: S.oneOf('Environment', ['practice', 'live'], 'practice'), apiKey: S.secret('API token'), accountId: S.str('Account ID') }, ['apiKey', 'accountId']),
    capabilities: { live: true }, impl: oanda,
  },
  {
    id: 'tradovate', kind: 'broker', name: 'Tradovate', category: 'Brokers', source: 'builtin', docsUrl: 'https://api.tradovate.com/',
    description: 'CME/ICE futures. Demo environment by default. Symbol is the contract, e.g. CLZ6.',
    configSchema: S.obj({ environment: S.oneOf('Environment', ['demo', 'live'], 'demo'), username: S.str('Username'), password: S.secret('Password'), cid: S.str('API client ID (cid)'), secret: S.secret('API secret'), appId: S.str('App ID', { default: 'Dhoomberg' }), accountName: S.str('Account name') }, ['username', 'password', 'cid', 'secret']),
    capabilities: { live: true }, impl: tradovate,
  },
  {
    id: 'ibkr', kind: 'broker', name: 'Interactive Brokers', category: 'Brokers', source: 'builtin', docsUrl: 'https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/#place-order',
    description: 'Futures, options, stocks worldwide via the Client Portal Gateway on this machine. Symbol is the contract ID (conid). Use a paper login for testing.',
    configSchema: S.obj({ environment: ENV(), gatewayUrl: S.url('Gateway URL', 'https://localhost:5000'), accountId: S.str('Account ID'), autoConfirmWarnings: S.bool('Auto-confirm IBKR order warnings', false, { description: 'Off: orders that trigger IBKR warnings stop as "needs confirmation".' }) }, ['accountId']),
    capabilities: { live: true }, impl: ibkr,
  },
];

export const BROKER_PLUGINS = BROKERS.map(withCommon);
