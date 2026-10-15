import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Bar, JSONSchema, Quote } from '../../shared/types';
import * as mock from '../../src/data/mock';
import { getJson, httpFetch, num, pluck, render, toIso } from '../http';
import { DATA_DIR } from '../paths';
import { AUTH_SCHEMA, authHeaders } from './authn';
import { need, S, type Ctx, type DataSourceImpl, type PluginDef } from './types';

// ── Demo (mock random walk, same generator the browser uses) ─────────────────
const demoLive = new Map<string, number>();

/** Advances a few random demo instruments, like the browser's offline ticker. */
export function demoTick(): { id: string; price: number }[] {
  const out: { id: string; price: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const c = mock.COMMODITIES[Math.floor(Math.random() * mock.COMMODITIES.length)];
    const prev = demoLive.get(c.id) ?? mock.history(c.id).at(-1)!.close;
    const next = mock.roundTo(prev * Math.exp(c.vol * 0.12 * mock.gauss(Math.random)), c.dp);
    demoLive.set(c.id, next);
    out.push({ id: c.id, price: next });
  }
  return out;
}

function demoQuote(symbol: string): Quote {
  if (!mock.COMMODITIES.some((x) => x.id === symbol)) throw new Error(`Unknown demo instrument ${symbol}`);
  return { price: demoLive.get(symbol) ?? mock.history(symbol).at(-1)!.close, ts: new Date().toISOString(), source: 'demo' };
}

export const demoSource: DataSourceImpl = {
  async fetchSeries(_ctx, symbol) {
    const h = mock.history(symbol).map((b) => ({ ...b }));
    const live = demoLive.get(symbol);
    if (live !== undefined) h[h.length - 1].close = live;
    return h;
  },
  async quote(_ctx, symbol) { return demoQuote(symbol); },
  async test() { return `${mock.COMMODITIES.length} simulated instruments`; },
};

// ── Generic REST / JSON ──────────────────────────────────────────────────────
export const REST_SCHEMA = S.obj({
  seriesUrl: S.str('History URL template', { 'x-placeholder': 'https://api.example.com/history?symbol={symbol}&from={from}&key={apiKey}', description: 'Placeholders: {symbol} {from} {to} {apiKey} and any setting name.' }),
  format: S.oneOf('Response format', ['json', 'csv', 'ndjson'], 'json'),
  rowsPath: S.str('Rows path', { description: 'Where the rows live, e.g. data.values. Leave empty if the response is the array. If it points to an object keyed by date, the key is used as the date.' }),
  columnar: S.bool('Columnar response (separate arrays for dates and closes)'),
  dateField: S.str('Date field / path', { default: 'date' }),
  closeField: S.str('Close field / path', { default: 'close' }),
  openField: S.str('Open field'), highField: S.str('High field'), lowField: S.str('Low field'), volumeField: S.str('Volume field'),
  scale: S.num('Price multiplier', 1, { description: 'e.g. 1e-9 for fixed-point feeds, 0.01 for cents' }),
  quoteUrl: S.str('Quote URL template (optional)', { description: 'A real-time quote endpoint. Without it the last bar is used, and its age blocks live orders.' }),
  quotePricePath: S.str('Quote price path', { default: 'price' }),
  quoteTimePath: S.str('Quote timestamp path', { description: "Leave empty if the endpoint is real-time and has no timestamp ('now' is used)." }),
  historyDays: S.num('History window (days)', 1825),
  insecureTls: S.bool('Allow self-signed TLS (local gateways only)'),
  ...AUTH_SCHEMA,
}, ['seriesUrl']);

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]?.trim() ?? ''])));
}

function vars(ctx: Ctx, symbol: string) {
  const days = Number(ctx.config.historyDays ?? 1825);
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  return { ...ctx.config, symbol, from, to, fromEpoch: Math.floor(Date.parse(from) / 1000), toEpoch: Math.floor(Date.now() / 1000) };
}

export function rowsToBars(rows: unknown[], c: Record<string, any>): Bar[] {
  const scale = Number(c.scale ?? 1) || 1;
  const field = (row: unknown, path: string | undefined) => (path ? num(pluck(row, path)) * scale : undefined);
  const bars: Bar[] = [];
  for (const row of rows) {
    const date = toIso(c.dateField === '$key' ? (row as { $key: string }).$key : pluck(row, c.dateField || 'date'));
    const close = num(pluck(row, c.closeField || 'close')) * scale;
    if (!date || !Number.isFinite(close)) continue;
    const b: Bar = { date, close };
    for (const [k, f] of [['open', c.openField], ['high', c.highField], ['low', c.lowField], ['volume', c.volumeField]] as const) {
      const v = field(row, f);
      if (v !== undefined && Number.isFinite(v)) b[k] = k === 'volume' ? v / scale : v;
    }
    bars.push(b);
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return bars.filter((b, i) => i === bars.length - 1 || b.date !== bars[i + 1].date);
}

export function extractRows(body: unknown, c: Record<string, any>): unknown[] {
  if (c.columnar) {
    const dates = pluck(body, c.dateField) as unknown[];
    const closes = pluck(body, c.closeField) as unknown[];
    if (!Array.isArray(dates) || !Array.isArray(closes)) throw new Error('Columnar paths did not resolve to arrays');
    return dates.map((d, i) => ({ date: d, close: closes[i] }));
  }
  const at = pluck(body, c.rowsPath);
  if (Array.isArray(at)) return at;
  if (at && typeof at === 'object') return Object.entries(at).map(([k, v]) => ({ ...(v as object), $key: k, $value: v }));
  throw new Error(`Rows path "${c.rowsPath ?? ''}" did not resolve to rows. Check the mapping against a sample response.`);
}

export const restSource: DataSourceImpl = {
  async fetchSeries(ctx, symbol) {
    const c = ctx.config;
    need(c, 'seriesUrl');
    const url = render(c.seriesUrl, vars(ctx, symbol), 'url');
    const headers = await authHeaders(c, ctx.connectionId);
    const res = await httpFetch(url, { headers, insecureTls: !!c.insecureTls, timeoutMs: 30_000 });
    let rows: unknown[];
    const fmt = c.format ?? 'json';
    if (fmt === 'csv') rows = parseCsv(await res.text());
    else if (fmt === 'ndjson') rows = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    else rows = extractRows(await res.json(), c);
    const mapped = c.columnar ? { ...c, dateField: 'date', closeField: 'close' } : c;
    const bars = rowsToBars(rows, mapped);
    if (!bars.length) throw new Error(`No bars parsed from ${new URL(url).host}. ${rows.length} rows found; check the date/close field paths.`);
    return bars;
  },
  async quote(ctx, symbol) {
    const c = ctx.config;
    if (!c.quoteUrl) {
      const bars = await ctx.cache(`series:${symbol}`, 60_000, () => restSource.fetchSeries(ctx, symbol, {}));
      const last = bars[bars.length - 1];
      return { price: last.close, ts: `${last.date.length === 7 ? last.date + '-01' : last.date}T00:00:00Z`, source: 'last-bar' };
    }
    const url = render(c.quoteUrl, vars(ctx, symbol), 'url');
    const body = await getJson(url, { headers: await authHeaders(c, ctx.connectionId), insecureTls: !!c.insecureTls });
    const price = num(pluck(body, c.quotePricePath || 'price')) * (Number(c.scale ?? 1) || 1);
    if (!Number.isFinite(price)) throw new Error(`Quote price path "${c.quotePricePath}" did not resolve to a number`);
    const ts = c.quoteTimePath ? toIso(pluck(body, c.quoteTimePath), false) : new Date().toISOString();
    if (!ts) throw new Error(`Quote timestamp path "${c.quoteTimePath}" did not resolve to a date`);
    return { price, ts, source: new URL(url).host };
  },
  async test(ctx) {
    const sym = String(ctx.config.testSymbol ?? ctx.config.symbolHint ?? '');
    const bars = await restSource.fetchSeries(ctx, sym, {});
    return `${bars.length} bars, ${bars[0].date} → ${bars[bars.length - 1].date}, last ${bars[bars.length - 1].close}`;
  },
};

// ── CSV (URL or uploaded file) ───────────────────────────────────────────────
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');

const csvSource: DataSourceImpl = {
  async fetchSeries(ctx, symbol) {
    const c = ctx.config;
    let text: string;
    if (c.file) {
      const f = join(UPLOAD_DIR, basename(String(c.file)));
      if (!existsSync(f)) throw new Error(`Uploaded file ${c.file} not found`);
      text = readFileSync(f, 'utf8');
    } else {
      need(c, 'url');
      text = await (await httpFetch(render(c.url, { ...c, symbol }, 'url'), { headers: await authHeaders(c, ctx.connectionId) })).text();
    }
    const rows = parseCsv(text);
    const closeField = symbol && rows[0] && symbol in rows[0] ? symbol : c.closeField || 'close';
    const bars = rowsToBars(rows, { ...c, closeField, dateField: c.dateField || 'date' });
    if (!bars.length) throw new Error(`No rows parsed. Columns found: ${Object.keys(rows[0] ?? {}).join(', ')}`);
    return bars;
  },
  async test(ctx) {
    const bars = await csvSource.fetchSeries(ctx, String(ctx.config.testSymbol ?? ''), {});
    return `${bars.length} rows, last ${bars[bars.length - 1].date} = ${bars[bars.length - 1].close}`;
  },
};

// ── WebSocket stream (live quotes) + optional REST history ───────────────────
type Stream = { ws: WebSocket; last: Map<string, Quote>; opened: number };
const streams = new Map<string, Stream>();

function openStream(ctx: Ctx): Stream {
  const key = ctx.connectionId;
  const existing = streams.get(key);
  if (existing && existing.ws.readyState <= 1) return existing;
  const c = ctx.config;
  need(c, 'wsUrl', 'pricePath');
  const ws = new WebSocket(render(c.wsUrl, c, 'url'));
  const s: Stream = { ws, last: new Map(), opened: Date.now() };
  ws.addEventListener('open', () => {
    if (c.subscribeMessage) {
      for (const sym of String(c.symbols ?? '').split(',').map((x) => x.trim()).filter(Boolean)) ws.send(render(c.subscribeMessage, { ...c, symbol: sym }));
    }
  });
  ws.addEventListener('message', (ev) => {
    try {
      const msgs = JSON.parse(String(ev.data));
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
        const price = num(pluck(m, c.pricePath));
        if (!Number.isFinite(price)) continue;
        const sym = c.symbolPath ? String(pluck(m, c.symbolPath)) : '*';
        const ts = c.timePath ? toIso(pluck(m, c.timePath), false) ?? new Date().toISOString() : new Date().toISOString();
        s.last.set(sym, { price, ts, source: 'ws' });
      }
    } catch { /* ignore non-JSON frames (heartbeats) */ }
  });
  ws.addEventListener('close', () => streams.delete(key));
  streams.set(key, s);
  return s;
}

const wsSource: DataSourceImpl = {
  async fetchSeries(ctx, symbol, opts) {
    if (!ctx.config.seriesUrl) throw new Error('This stream has no history URL configured; it can supply live quotes only.');
    return restSource.fetchSeries(ctx, symbol, opts);
  },
  async quote(ctx, symbol) {
    const s = openStream(ctx);
    for (let i = 0; i < 50; i++) {
      const q = s.last.get(symbol) ?? s.last.get('*');
      if (q) return q;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`No ${symbol} message received from the stream within 5s`);
  },
  async test(ctx) {
    const sym = String(ctx.config.symbols ?? '').split(',')[0]?.trim() ?? '*';
    const q = await wsSource.quote!(ctx, sym);
    return `Live ${sym} = ${q.price} at ${q.ts}`;
  },
};

// ── Presets: fixed config on top of the generic REST adapter ─────────────────
type Preset = {
  id: string; name: string; category: string; description: string; docsUrl: string; symbolHint: string;
  fixed: Record<string, unknown>; key?: 'required' | 'optional' | 'none'; realtime?: boolean; extra?: Record<string, JSONSchema>;
};

function preset(p: Preset): PluginDef {
  const props: Record<string, JSONSchema> = { ...(p.extra ?? {}) };
  if (p.key !== 'none') props.apiKey = S.secret('API key');
  props.testSymbol = S.str('Symbol used by "Test connection"', { default: p.symbolHint });
  const impl: DataSourceImpl = {
    fetchSeries: (ctx, sym, o) => restSource.fetchSeries({ ...ctx, config: { ...p.fixed, ...ctx.config } }, sym, o),
    quote: (ctx, sym) => restSource.quote!({ ...ctx, config: { ...p.fixed, ...ctx.config } }, sym),
    test: (ctx) => restSource.test({ ...ctx, config: { ...p.fixed, ...ctx.config } }),
  };
  return {
    id: p.id, kind: 'datasource', name: p.name, category: p.category, description: p.description, docsUrl: p.docsUrl, source: 'builtin',
    configSchema: S.obj(props, p.key === 'required' ? ['apiKey'] : []),
    capabilities: { realtime: !!p.realtime, symbolHint: p.symbolHint },
    impl,
  };
}

const PRESETS: Preset[] = [
  {
    id: 'fred', name: 'FRED (St. Louis Fed)', category: 'Macro & government', description: '800k+ economic series: rates, production, inflation, commodity indices.',
    docsUrl: 'https://fred.stlouisfed.org/docs/api/api_key.html', symbolHint: 'DCOILBRENTEU', key: 'required',
    fixed: { seriesUrl: 'https://api.stlouisfed.org/fred/series/observations?series_id={symbol}&api_key={apiKey}&file_type=json&observation_start={from}', rowsPath: 'observations', dateField: 'date', closeField: 'value' },
  },
  {
    id: 'eia', name: 'EIA (US Energy Information Admin.)', category: 'Macro & government', description: 'Petroleum, gas, power and coal series via the v2 series-ID endpoint.',
    docsUrl: 'https://www.eia.gov/opendata/', symbolHint: 'PET.RWTC.D', key: 'required',
    fixed: { seriesUrl: 'https://api.eia.gov/v2/seriesid/{symbol}?api_key={apiKey}', rowsPath: 'response.data', dateField: 'period', closeField: 'value' },
  },
  {
    id: 'usda_quickstats', name: 'USDA NASS QuickStats', category: 'Macro & government', description: 'US crop and livestock statistics. Symbol is the QuickStats query string.',
    docsUrl: 'https://quickstats.nass.usda.gov/api', symbolHint: 'commodity_desc=CORN&statisticcat_desc=PRICE RECEIVED&agg_level_desc=NATIONAL&freq_desc=MONTHLY', key: 'required',
    fixed: { seriesUrl: 'https://quickstats.nass.usda.gov/api/api_GET/?key={apiKey}&format=JSON&{symbol}', rowsPath: 'data', dateField: 'year', closeField: 'Value' },
  },
  {
    id: 'alphavantage', name: 'Alpha Vantage Commodities', category: 'Market data', description: 'WTI, BRENT, NATURAL_GAS, COPPER, ALUMINUM, WHEAT, CORN, COTTON, SUGAR, COFFEE (monthly/daily).',
    docsUrl: 'https://www.alphavantage.co/documentation/#commodities', symbolHint: 'WTI', key: 'required',
    fixed: { seriesUrl: 'https://www.alphavantage.co/query?function={symbol}&interval=daily&apikey={apiKey}', rowsPath: 'data', dateField: 'date', closeField: 'value' },
  },
  {
    id: 'alphavantage_equity', name: 'Alpha Vantage Stocks & ETFs', category: 'Market data', description: 'Daily equity/ETF prices (e.g. commodity ETFs like USO, GLD, CORN).',
    docsUrl: 'https://www.alphavantage.co/documentation/#daily', symbolHint: 'USO', key: 'required',
    fixed: { seriesUrl: 'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol={symbol}&outputsize=full&apikey={apiKey}', rowsPath: '["Time Series (Daily)"]', dateField: '$key', closeField: '["4. close"]', openField: '["1. open"]', highField: '["2. high"]', lowField: '["3. low"]', volumeField: '["5. volume"]', quoteUrl: 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol={symbol}&apikey={apiKey}', quotePricePath: '["Global Quote"]["05. price"]', quoteTimePath: '["Global Quote"]["07. latest trading day"]' },
  },
  {
    id: 'twelvedata', name: 'Twelve Data', category: 'Market data', description: 'Stocks, ETFs, FX, crypto and commodities with real-time quotes.',
    docsUrl: 'https://twelvedata.com/docs', symbolHint: 'XAU/USD', key: 'required', realtime: true,
    fixed: { seriesUrl: 'https://api.twelvedata.com/time_series?symbol={symbol}&interval=1day&outputsize=5000&apikey={apiKey}', rowsPath: 'values', dateField: 'datetime', closeField: 'close', openField: 'open', highField: 'high', lowField: 'low', volumeField: 'volume', quoteUrl: 'https://api.twelvedata.com/quote?symbol={symbol}&apikey={apiKey}', quotePricePath: 'close', quoteTimePath: 'timestamp' },
  },
  {
    id: 'polygon', name: 'Polygon.io', category: 'Market data', description: 'US stocks, options, FX and crypto aggregates.',
    docsUrl: 'https://polygon.io/docs', symbolHint: 'C:XAUUSD', key: 'required', realtime: true,
    fixed: { seriesUrl: 'https://api.polygon.io/v2/aggs/ticker/{symbol}/range/1/day/{from}/{to}?adjusted=true&sort=asc&limit=50000&apiKey={apiKey}', rowsPath: 'results', dateField: 't', closeField: 'c', openField: 'o', highField: 'h', lowField: 'l', volumeField: 'v', quoteUrl: 'https://api.polygon.io/v2/last/trade/{symbol}?apiKey={apiKey}', quotePricePath: 'results.p', quoteTimePath: 'results.t' },
  },
  {
    id: 'nasdaq_datalink', name: 'Nasdaq Data Link', category: 'Market data', description: 'Time-series datasets (formerly Quandl). Symbol is DATABASE/DATASET.',
    docsUrl: 'https://docs.data.nasdaq.com/', symbolHint: 'OPEC/ORB', key: 'required',
    fixed: { seriesUrl: 'https://data.nasdaq.com/api/v3/datasets/{symbol}.json?api_key={apiKey}&start_date={from}', rowsPath: 'dataset.data', dateField: '[0]', closeField: '[1]' },
  },
  {
    id: 'tiingo', name: 'Tiingo', category: 'Market data', description: 'End-of-day prices for stocks and ETFs.',
    docsUrl: 'https://www.tiingo.com/documentation/end-of-day', symbolHint: 'GLD', key: 'required',
    fixed: { seriesUrl: 'https://api.tiingo.com/tiingo/daily/{symbol}/prices?startDate={from}&token={apiKey}', rowsPath: '', dateField: 'date', closeField: 'adjClose', openField: 'adjOpen', highField: 'adjHigh', lowField: 'adjLow', volumeField: 'adjVolume' },
  },
  {
    id: 'yahoo', name: 'Yahoo Finance (unofficial)', category: 'Market data', description: 'Free futures and stock prices, e.g. CL=F, GC=F, SB=F, CC=F, KC=F. Delayed ~10-15 min, so usable for alerts and paper trading but never for live orders. Unofficial endpoint; may change without notice.',
    docsUrl: 'https://finance.yahoo.com/commodities', symbolHint: 'CL=F', key: 'none', realtime: false,
    fixed: { seriesUrl: 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5y&interval=1d', columnar: true, dateField: 'chart.result[0].timestamp', closeField: 'chart.result[0].indicators.quote[0].close', quoteUrl: 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=1m', quotePricePath: 'chart.result[0].meta.regularMarketPrice', quoteTimePath: 'chart.result[0].meta.regularMarketTime' },
  },
  {
    id: 'barchart', name: 'Barchart OnDemand', category: 'Market data', description: 'Futures and physical commodity prices (paid).',
    docsUrl: 'https://www.barchart.com/ondemand/api', symbolHint: 'ZCZ26', key: 'required', realtime: true,
    fixed: { seriesUrl: 'https://ondemand.websol.barchart.com/getHistory.json?apikey={apiKey}&symbol={symbol}&type=daily&startDate={from}', rowsPath: 'results', dateField: 'tradingDay', closeField: 'close', openField: 'open', highField: 'high', lowField: 'low', volumeField: 'volume', quoteUrl: 'https://ondemand.websol.barchart.com/getQuote.json?apikey={apiKey}&symbols={symbol}', quotePricePath: 'results[0].lastPrice', quoteTimePath: 'results[0].serverTimestamp' },
  },
  {
    id: 'databento', name: 'Databento', category: 'Market data', description: 'CME Globex and other venues, daily OHLCV. Symbol like CL.c.0 (continuous). Uses HTTP basic auth with your key as the username.',
    docsUrl: 'https://databento.com/docs/api-reference-historical', symbolHint: 'CL.c.0', key: 'none',
    extra: { dataset: S.str('Dataset', { default: 'GLBX.MDP3' }), username: S.secret('API key') },
    fixed: { authType: 'basic', format: 'ndjson', seriesUrl: 'https://hist.databento.com/v0/timeseries.get_range?dataset={dataset}&symbols={symbol}&stype_in=continuous&schema=ohlcv-1d&start={from}&encoding=json', dateField: 'hd.ts_event', closeField: 'close', openField: 'open', highField: 'high', lowField: 'low', volumeField: 'volume', scale: 1e-9 },
  },
  {
    id: 'binance', name: 'Binance', category: 'Crypto', description: 'Spot klines and live ticker (no key needed for market data).',
    docsUrl: 'https://developers.binance.com/docs/binance-spot-api-docs', symbolHint: 'PAXGUSDT', key: 'none', realtime: true,
    fixed: { seriesUrl: 'https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&limit=1000', rowsPath: '', dateField: '[0]', openField: '[1]', highField: '[2]', lowField: '[3]', closeField: '[4]', volumeField: '[5]', quoteUrl: 'https://api.binance.com/api/v3/ticker/price?symbol={symbol}', quotePricePath: 'price' },
  },
  {
    id: 'coinbase', name: 'Coinbase Exchange', category: 'Crypto', description: 'Daily candles and live ticker (public market data).',
    docsUrl: 'https://docs.cdp.coinbase.com/exchange/reference', symbolHint: 'BTC-USD', key: 'none', realtime: true,
    fixed: { seriesUrl: 'https://api.exchange.coinbase.com/products/{symbol}/candles?granularity=86400', rowsPath: '', dateField: '[0]', lowField: '[1]', highField: '[2]', openField: '[3]', closeField: '[4]', volumeField: '[5]', quoteUrl: 'https://api.exchange.coinbase.com/products/{symbol}/ticker', quotePricePath: 'price', quoteTimePath: 'time' },
  },
  {
    id: 'oanda_prices', name: 'OANDA Pricing', category: 'Broker data', description: 'Commodity CFDs: BCO_USD, WTICO_USD, XAU_USD, CORN_USD, WHEAT_USD, SUGAR_USD, SOYBN_USD, NATGAS_USD.',
    docsUrl: 'https://developer.oanda.com/rest-live-v20/instrument-ep/', symbolHint: 'BCO_USD', key: 'required', realtime: true,
    extra: { environment: S.oneOf('Environment', ['practice', 'live'], 'practice'), accountId: S.str('Account ID (for live quotes)') },
    fixed: { authType: 'bearer', seriesUrl: 'https://{oandaHost}/v3/instruments/{symbol}/candles?granularity=D&count=2000&price=M', rowsPath: 'candles', dateField: 'time', closeField: 'mid.c', openField: 'mid.o', highField: 'mid.h', lowField: 'mid.l', volumeField: 'volume', quoteUrl: 'https://{oandaHost}/v3/accounts/{accountId}/pricing?instruments={symbol}', quotePricePath: 'prices[0].closeoutBid', quoteTimePath: 'prices[0].time' },
  },
  {
    id: 'ibkr_data', name: 'Interactive Brokers market data', category: 'Broker data', description: 'Via the Client Portal Gateway running on this machine. Symbol is the IBKR contract ID (conid).',
    docsUrl: 'https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/', symbolHint: '265598', key: 'none', realtime: true,
    extra: { gatewayUrl: S.url('Gateway URL', 'https://localhost:5000') },
    fixed: { insecureTls: true, seriesUrl: '{gatewayUrl}/v1/api/iserver/marketdata/history?conid={symbol}&period=5y&bar=1d', rowsPath: 'data', dateField: 't', closeField: 'c', openField: 'o', highField: 'h', lowField: 'l', volumeField: 'v', quoteUrl: '{gatewayUrl}/v1/api/iserver/marketdata/snapshot?conids={symbol}&fields=31,_updated', quotePricePath: '[0]["31"]', quoteTimePath: '[0]._updated' },
  },
];

export const DATASOURCE_PLUGINS: PluginDef[] = [
  {
    id: 'demo', kind: 'datasource', name: 'Demo (simulated)', category: 'Built-in', source: 'builtin',
    description: 'Seeded random-walk prices for the 46 default commodities. Never usable for live orders.',
    configSchema: S.obj({}), capabilities: { realtime: false, symbolHint: 'SUGAR' }, impl: demoSource,
  },
  {
    id: 'rest', kind: 'datasource', name: 'Generic REST / JSON API', category: 'Generic', source: 'builtin',
    description: 'Any HTTP API that returns price history as JSON, CSV or NDJSON. Map the fields once and use any symbol.',
    configSchema: { ...REST_SCHEMA, properties: { ...REST_SCHEMA.properties, testSymbol: S.str('Symbol used by "Test connection"') } },
    capabilities: { realtime: false }, impl: restSource,
  },
  {
    id: 'csv', kind: 'datasource', name: 'CSV file or URL', category: 'Generic', source: 'builtin',
    description: 'Upload a CSV or point at one online. Each numeric column can be its own instrument (symbol = column name).',
    configSchema: S.obj({
      file: S.str('Uploaded file', { description: 'Upload in Settings → Data Sources' }),
      url: S.url('…or CSV URL'), dateField: S.str('Date column', { default: 'date' }), closeField: S.str('Default value column', { default: 'close' }),
      testSymbol: S.str('Column used by "Test connection"'), ...AUTH_SCHEMA,
    }),
    capabilities: { realtime: false }, impl: csvSource,
  },
  {
    id: 'websocket', kind: 'datasource', name: 'WebSocket stream', category: 'Generic', source: 'builtin',
    description: 'Live quotes from any JSON WebSocket feed, plus optional REST history.',
    configSchema: S.obj({
      wsUrl: S.str('WebSocket URL', { 'x-placeholder': 'wss://stream.example.com/ws?token={apiKey}' }),
      symbols: S.str('Symbols to subscribe (comma-separated)'),
      subscribeMessage: S.text('Subscribe message template', undefined, { description: 'Sent once per symbol, e.g. {"action":"subscribe","symbol":"{symbol}"}' }),
      symbolPath: S.str('Symbol path in messages'), pricePath: S.str('Price path in messages', { default: 'price' }), timePath: S.str('Timestamp path in messages'),
      seriesUrl: S.str('History URL template (optional)'), rowsPath: S.str('History rows path'), dateField: S.str('History date field', { default: 'date' }), closeField: S.str('History close field', { default: 'close' }),
      apiKey: S.secret('API key'),
    }, ['wsUrl', 'pricePath']),
    capabilities: { realtime: true }, impl: wsSource,
  },
  ...PRESETS.map((p) => {
    const def = preset(p);
    // OANDA's environment lives in the host name: api-fxpractice / api-fxtrade.
    if (p.id === 'oanda_prices') {
      const impl = def.impl as DataSourceImpl;
      const host = (c: Record<string, any>) => ({ ...c, oandaHost: c.environment === 'live' ? 'api-fxtrade.oanda.com' : 'api-fxpractice.oanda.com' });
      def.impl = {
        fetchSeries: (ctx, s, o) => impl.fetchSeries({ ...ctx, config: host(ctx.config) }, s, o),
        quote: (ctx, s) => impl.quote!({ ...ctx, config: host(ctx.config) }, s),
        test: (ctx) => impl.test({ ...ctx, config: host(ctx.config) }),
      };
    }
    return def;
  }),
];
