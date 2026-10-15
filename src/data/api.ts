import { DEMO_MODE } from './config';
import * as mock from './mock';
import type { Bar, Chokepoint, NewsItem, RiskAlert } from './mock';
import type { Instrument, NewsItem as RealNews } from '../../shared/types';
import { api, serverOnline } from '../lib/server';

export type { Bar, Chokepoint, RiskAlert, NewsTag, Threat } from './mock';

// Legacy NewsItem (mock) — still exported for getNews() mock path
export type { NewsItem } from './mock';

export type RealNewsItem = RealNews;
type RealNewsFile = { asOf: string; sources: Record<string, boolean>; items: RealNewsItem[] };

let realNewsFile: Promise<RealNewsFile> | null = null;
export async function getRealNews(connectionId?: string): Promise<{ items: RealNewsItem[]; sources: string[]; demo: boolean; errors?: Record<string, string> }> {
  if (await serverOnline()) {
    return api.get(`/news${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`);
  }
  realNewsFile ??= mlFetch<RealNewsFile>('news/news.json');
  return { items: (await realNewsFile).items, sources: ['Demo feed'], demo: true };
}

export type Quote = {
  id: string;
  code: string;
  name: string;
  unit: string;
  dp: number;
  last: number;
  prevClose: number;
  low52: number;
  high52: number;
};

function notConfigured(name: string): never {
  throw new Error(`${name}: live connector not configured. Enable DEMO_MODE or add API credentials.`);
}

export type InstrumentInfo = Pick<Instrument, 'id' | 'code' | 'name' | 'unit' | 'dp'> & Partial<Instrument> & { realtime?: boolean };

/** Instruments known to the terminal: from the server when it runs, otherwise the demo set. */
export async function getInstruments(): Promise<InstrumentInfo[]> {
  if (await serverOnline()) return api.get<InstrumentInfo[]>('/instruments');
  return mock.COMMODITIES.map((c) => ({ id: c.id, code: c.code, name: c.name, unit: c.unit, dp: c.dp }));
}

export async function getWatchlist(ids?: string[]): Promise<Quote[]> {
  if (await serverOnline()) {
    const want = ids ?? (await getInstruments()).map((i) => i.id);
    const rows = await api.get<(Quote & { error: string | null })[]>(`/watchlist?ids=${encodeURIComponent(want.join(','))}`);
    return rows.filter((r) => !r.error);
  }
  if (!DEMO_MODE) notConfigured('getWatchlist');
  return mock.COMMODITIES.filter((c) => !ids || ids.includes(c.id)).map((c) => {
    const h = mock.history(c.id);
    const year = h.slice(-260).map((b) => b.close);
    return {
      id: c.id, code: c.code, name: c.name, unit: c.unit, dp: c.dp,
      last: h[h.length - 1].close, prevClose: h[h.length - 2].close,
      low52: Math.min(...year), high52: Math.max(...year),
    };
  });
}

export async function getPriceHistory(id: string): Promise<Bar[]> {
  if (await serverOnline()) return api.get<Bar[]>(`/series/${encodeURIComponent(id)}`);
  if (!DEMO_MODE) notConfigured('getPriceHistory');
  return mock.history(id);
}

export async function getChokepoints(): Promise<Chokepoint[]> {
  if (!DEMO_MODE) notConfigured('getChokepoints');
  return mock.CHOKEPOINTS;
}

export async function getRiskAlerts(): Promise<RiskAlert[]> {
  if (!DEMO_MODE) notConfigured('getRiskAlerts');
  return mock.RISK_ALERTS;
}

export async function getNews(): Promise<NewsItem[]> {
  if (!DEMO_MODE) notConfigured('getNews');
  return mock.NEWS;
}

// ── ML-02 seasonal decomposition ────────────────────────────────────────────
export type SeasonalPoint = { date: string; original: number; trend: number; seasonal: number; residual: number };
export type SeasonalCommodity = {
  series: string; unit: string; seasonalStrength: number; noSeasonalPattern: boolean;
  residualAutocorr: boolean; decompositionCheck: boolean; note: string;
  seasonalPattern: Record<string, number>; data: SeasonalPoint[];
};
type SeasonalFile = { model: string; source: string; dataThrough: string; windowYears: number; commodities: Record<string, SeasonalCommodity> };
export type SeasonalResult = Omit<SeasonalFile, 'commodities'> & SeasonalCommodity;

// ── ML-04 leading indicators ─────────────────────────────────────────────────
export type Indicator = {
  indicator: string; name: string; description: string; lagMonths: number;
  discoveryCorr: number; grangerP: number; grangerThreshold: number;
  oosCorr: number; oosThreshold: number; pass: boolean; status: string; direction: 'positive' | 'negative';
};
export type IndicatorCommodity = { series: string; unit: string; nPass: number; indicators: Indicator[] };
type IndicatorFile = { model: string; discoveryPeriod: string; oosPeriod: string; bonferroniAlpha: number; oosCorrMin: number; commodities: Record<string, IndicatorCommodity> };
export type IndicatorResult = Omit<IndicatorFile, 'commodities'> & IndicatorCommodity;

// ── ML-06 corridor threat ────────────────────────────────────────────────────
export type ChokeData = {
  name: string; transitVolume: string; threatScore: number; threatLevel: number;
  advisory: string; incidents30d: number; primaryDriver: string; lastIncident: string;
  vesselFlowVsAvg: number; transitIndexVsAvg: number; queueVessels: number;
  rerouteVia: string | null; rerouteUsdTeu: number | null; rerouteDays: number | null;
  scoreComponents: Record<string, number>;
};
type ChokeFile = { model: string; asOf: string; calibration: { status: string }; chokepoints: Record<string, ChokeData> };

// ── ML-08 supplier risk ──────────────────────────────────────────────────────
export type Supplier = {
  id: string; name: string; country: string; commodity: string;
  riskScore: number; ragStatus: 'RED' | 'AMBER' | 'GREEN'; topDriver: string;
  dimensions: Record<string, number>; spendPct: number; creditScore: number; dpoTrend: string;
};
type SupplierFile = { model: string; weights: Record<string, number>; dataSources: Record<string, string>; asOf: string; suppliers: Supplier[] };

// ── ML-09 lane risk ──────────────────────────────────────────────────────────
export type Lane = {
  lane: string; corridor: string; carrier: string; laneRiskScore: number;
  ragStatus: string; riskTrend: string; topDriver: string;
  forecastSignal: { action: string; daysToAdd: number };
  componentScores: Record<string, number>;
};
type LaneFile = { model: string; asOf: string; ml05Note: string; ml07Note: string; lanes: Lane[] };

export type ForecastPoint = { date: string; p10: number; p50: number; p90: number };
export type ForecastHorizon = {
  h: number;
  skill: number;
  dmP: number;
  coverage80: number;
  mape: number;
  naiveMape: number;
  pass: boolean;
  n: number;
  perCommodity: Record<string, number>;
};
type ForecastFile = {
  model: string;
  source: string;
  dataThrough: string;
  testPeriod: string;
  criteria: string;
  horizons: ForecastHorizon[];
  commodities: Record<string, { series: string; unit: string; history: Bar[]; forecast: ForecastPoint[] }>;
};
export type ForecastResult = Omit<ForecastFile, 'commodities'> & ForecastFile['commodities'][string];

let forecastFile: Promise<ForecastFile> | null = null;

// ML-01 output is produced offline by research/ml01.py from real data, so it is served in every mode.
export async function getForecast(id: string): Promise<ForecastResult> {
  forecastFile ??= fetch(`${import.meta.env.BASE_URL}forecast/ml01.json`).then((r) => {
    if (!r.ok) throw new Error(`Forecast file missing (${r.status}). Run research/ml01.py export.`);
    return r.json() as Promise<ForecastFile>;
  });
  const { commodities, ...meta } = await forecastFile;
  const c = commodities[id];
  if (!c) throw new Error(`No free monthly price series for ${id}, so ML-01 has no forecast for it.`);
  return { ...meta, ...c };
}

// ── ML output file fetchers ───────────────────────────────────────────────────
function mlFetch<T>(path: string): Promise<T> {
  return fetch(`${import.meta.env.BASE_URL}${path}`).then((r) => {
    if (!r.ok) throw new Error(`${path} missing (${r.status}). Run the matching research/ml*.py script.`);
    return r.json() as Promise<T>;
  });
}

let seasonalFile: Promise<SeasonalFile> | null = null;
export async function getSeasonal(id: string): Promise<SeasonalResult> {
  seasonalFile ??= mlFetch<SeasonalFile>('seasonal/ml02.json');
  const { commodities, ...meta } = await seasonalFile;
  const c = commodities[id];
  if (!c) throw new Error(`No seasonal data for ${id}.`);
  return { ...meta, ...c };
}

let indicatorFile: Promise<IndicatorFile> | null = null;
export async function getIndicators(id: string): Promise<IndicatorResult> {
  indicatorFile ??= mlFetch<IndicatorFile>('indicators/ml04.json');
  const { commodities, ...meta } = await indicatorFile;
  const c = commodities[id];
  if (!c) throw new Error(`No indicator data for ${id}.`);
  return { ...meta, ...c };
}

let chokeFile: Promise<ChokeFile> | null = null;
export async function getChokeML(): Promise<Record<string, ChokeData>> {
  chokeFile ??= mlFetch<ChokeFile>('chokepoint/ml06.json');
  return (await chokeFile).chokepoints;
}

let supplierFile: Promise<SupplierFile> | null = null;
export async function getSuppliers(): Promise<{ meta: SupplierFile; suppliers: Supplier[] }> {
  supplierFile ??= mlFetch<SupplierFile>('supplier/ml08.json');
  const data = await supplierFile;
  return { meta: data, suppliers: data.suppliers };
}

let laneFile: Promise<LaneFile> | null = null;
export async function getLanes(): Promise<{ meta: LaneFile; lanes: Lane[] }> {
  laneFile ??= mlFetch<LaneFile>('lanes/ml09.json');
  const data = await laneFile;
  return { meta: data, lanes: data.lanes };
}

// ── ML-Demand ─────────────────────────────────────────────────────────────────
export type DemandSeriesPoint = { date: string; value: number };
export type DemandSeries = {
  name: string; source: string; unit: string;
  latest: number; latestDate: string; mom: number; yoy: number;
  history: DemandSeriesPoint[];
  threshold?: number; expanding?: boolean; streak?: number; streakDirection?: string;
  weekChange?: number; weekChangePct?: number; direction?: string;
};
export type CotPoint = { date: string; netLong: number; oi: number };
export type CotRecord = {
  name: string; latestDate: string; netLong: number; openInterest: number;
  netLongPct: number; weekChange: number; crowdedLong: boolean; crowdedShort: boolean;
  history: CotPoint[];
};
export type DemandAlert = {
  id: string; type: string; severity: 'RED' | 'AMBER' | 'GREEN';
  title: string; message: string; commodities: string[];
  value: number; threshold: number;
};
export type DemandData = {
  model: string; source: string; asOf: string;
  series: Record<string, DemandSeries>;
  cot: Record<string, CotRecord>;
  alerts: DemandAlert[];
};

let demandFile: Promise<DemandData> | null = null;
export async function getDemandData(): Promise<DemandData> {
  demandFile ??= mlFetch<DemandData>('demand/demand.json');
  return demandFile;
}

/** Live prices: polls the server's quotes when it runs, otherwise a local random walk. */
export function subscribeTicks(onTick: (id: string, price: number) => void, getIds: () => string[] = () => mock.COMMODITIES.map((c) => c.id)): () => void {
  let stopped = false;
  let timer = 0;
  serverOnline().then((online) => {
    if (stopped) return;
    if (online) {
      const last = new Map<string, number>();
      const poll = async () => {
        const ids = getIds();
        if (!ids.length) return;
        try {
          const q = await api.get<Record<string, { price?: number }>>(`/quotes?ids=${encodeURIComponent(ids.join(','))}`);
          for (const [id, v] of Object.entries(q)) {
            if (v.price === undefined || last.get(id) === v.price) continue;
            last.set(id, v.price);
            onTick(id, v.price);
          }
        } catch { /* server hiccup; next poll */ }
      };
      timer = window.setInterval(poll, 2000);
      return;
    }
    if (!DEMO_MODE) notConfigured('subscribeTicks');
    const live = new Map(mock.COMMODITIES.map((c) => [c.id, mock.history(c.id).at(-1)!.close]));
    timer = window.setInterval(() => {
      for (let i = 0; i < 3; i++) {
        const c = mock.COMMODITIES[Math.floor(Math.random() * mock.COMMODITIES.length)];
        const prev = live.get(c.id)!;
        const next = mock.roundTo(prev * Math.exp(c.vol * 0.12 * mock.gauss(Math.random)), c.dp);
        live.set(c.id, next);
        onTick(c.id, next);
      }
    }, 1500);
  });
  return () => { stopped = true; window.clearInterval(timer); };
}
