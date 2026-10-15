// Built-in forecast models. Every forecast is evaluated out-of-sample against the naive
// (last value) forecast with a rolling-origin backtest; prediction bands come from the
// empirical distribution of those out-of-sample errors, not from model assumptions.
import type { Bar, ForecastPoint, ForecastResult } from './types';

export type ModelMeta = { id: string; name: string; description: string; seasonal?: boolean };

export const BUILTIN_MODELS: ModelMeta[] = [
  { id: 'naive', name: 'Naive (last value)', description: 'Random-walk baseline every other model must beat' },
  { id: 'snaive', name: 'Seasonal naive', description: 'Value from one season ago', seasonal: true },
  { id: 'drift', name: 'Drift', description: 'Last value plus the average historical step' },
  { id: 'lintrend', name: 'Linear trend', description: 'OLS trend over the last 60 bars, in log space' },
  { id: 'holt', name: 'Holt damped trend', description: 'Exponential smoothing with damped trend, grid-fitted' },
  { id: 'hw', name: 'Holt-Winters', description: 'Additive seasonal exponential smoothing, grid-fitted', seasonal: true },
];

type Fn = (y: number[], h: number, m: number) => number[];

const naive: Fn = (y, h) => new Array(h).fill(y[y.length - 1]);

const snaive: Fn = (y, h, m) => {
  if (y.length < m) return naive(y, h, m);
  return Array.from({ length: h }, (_, i) => y[y.length - m + (i % m)]);
};

const drift: Fn = (y, h) => {
  const step = (y[y.length - 1] - y[0]) / Math.max(y.length - 1, 1);
  return Array.from({ length: h }, (_, i) => y[y.length - 1] + step * (i + 1));
};

const lintrend: Fn = (y, h) => {
  const n = Math.min(60, y.length);
  const t = y.slice(-n);
  const xm = (n - 1) / 2;
  const ym = t.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  t.forEach((v, i) => { sxy += (i - xm) * (v - ym); sxx += (i - xm) ** 2; });
  const b = sxx ? sxy / sxx : 0;
  return Array.from({ length: h }, (_, i) => ym + b * (n - 1 - xm + i + 1));
};

function holtSse(y: number[], a: number, b: number, phi: number): { sse: number; level: number; trend: number } {
  let level = y[0], trend = y.length > 1 ? y[1] - y[0] : 0, sse = 0;
  for (let i = 1; i < y.length; i++) {
    const f = level + phi * trend;
    sse += (y[i] - f) ** 2;
    const nl = a * y[i] + (1 - a) * f;
    trend = b * (nl - level) + (1 - b) * phi * trend;
    level = nl;
  }
  return { sse, level, trend };
}

const holt: Fn = (y, h) => {
  let best = { sse: Infinity, level: 0, trend: 0, phi: 1 };
  for (const a of [0.1, 0.3, 0.5, 0.7, 0.9, 1])
    for (const b of [0.01, 0.05, 0.1, 0.2])
      for (const phi of [0.8, 0.9, 0.95, 0.98]) {
        const r = holtSse(y, a, b, phi);
        if (r.sse < best.sse) best = { ...r, phi };
      }
  const out: number[] = [];
  let damp = 0;
  for (let i = 1; i <= h; i++) { damp += best.phi ** i; out.push(best.level + damp * best.trend); }
  return out;
};

function hwFit(y: number[], m: number, a: number, b: number, g: number) {
  let level = y.slice(0, m).reduce((s, v) => s + v, 0) / m;
  let trend = (y.slice(m, 2 * m).reduce((s, v) => s + v, 0) / m - level) / m;
  const season = y.slice(0, m).map((v) => v - level);
  let sse = 0;
  for (let i = m; i < y.length; i++) {
    const s = season[i % m];
    const f = level + trend + s;
    sse += (y[i] - f) ** 2;
    const nl = a * (y[i] - s) + (1 - a) * (level + trend);
    trend = b * (nl - level) + (1 - b) * trend;
    season[i % m] = g * (y[i] - nl) + (1 - g) * s;
    level = nl;
  }
  return { sse, level, trend, season, n: y.length };
}

const hw: Fn = (y, h, m) => {
  if (y.length < 2 * m + 2) return holt(y, h, m);
  let best: ReturnType<typeof hwFit> | null = null;
  for (const a of [0.1, 0.3, 0.5, 0.8])
    for (const b of [0.01, 0.05, 0.1])
      for (const g of [0.05, 0.1, 0.3]) {
        const r = hwFit(y, m, a, b, g);
        if (!best || r.sse < best.sse) best = r;
      }
  const r = best!;
  return Array.from({ length: h }, (_, i) => r.level + (i + 1) * r.trend + r.season[(r.n + i) % m]);
};

const FNS: Record<string, Fn> = { naive, snaive, drift, lintrend, holt, hw };

// ── Dates ────────────────────────────────────────────────────────────────────
export function inferFrequency(dates: string[]): 'daily' | 'weekly' | 'monthly' {
  if (dates.length < 3) return 'daily';
  const a = Date.parse(dates[dates.length - 1]);
  const b = Date.parse(dates[Math.max(0, dates.length - 11)]);
  const avgDays = (a - b) / 86_400_000 / Math.min(10, dates.length - 1);
  if (avgDays > 20) return 'monthly';
  if (avgDays > 5) return 'weekly';
  return 'daily';
}

export function seasonPeriod(freq: 'daily' | 'weekly' | 'monthly'): number {
  return freq === 'monthly' ? 12 : freq === 'weekly' ? 52 : 5;
}

export function nextDates(dates: string[], h: number): string[] {
  const freq = inferFrequency(dates);
  const last = dates[dates.length - 1];
  const monthly = /^\d{4}-\d{2}$/.test(last);
  const d = new Date(monthly ? `${last}-01T00:00:00Z` : `${last.slice(0, 10)}T00:00:00Z`);
  const out: string[] = [];
  while (out.length < h) {
    if (freq === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
    else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    }
    const iso = d.toISOString().slice(0, 10);
    out.push(monthly ? iso.slice(0, 7) : iso);
  }
  return out;
}

// ── Evaluation ───────────────────────────────────────────────────────────────
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Takes raw prices, returns `h` raw price forecasts. */
export type PointForecaster = (closes: number[], h: number) => Promise<number[]> | number[];

/** Rolling-origin backtest of any point forecaster vs naive, on raw prices. */
export async function evaluateForecaster(
  modelName: string,
  bars: Bar[],
  horizon: number,
  forecaster: PointForecaster,
  opts: { origins?: number; minTrain?: number } = {},
): Promise<ForecastResult> {
  const closes = bars.map((b) => b.close);
  const dates = bars.map((b) => b.date);
  const useLog = closes.every((v) => v > 0);
  const tx = (v: number) => (useLog ? Math.log(v) : v);
  const inv = (v: number) => (useLog ? Math.exp(v) : v);

  const K = opts.origins ?? 24;
  const minTrain = opts.minTrain ?? Math.max(60, Math.floor(closes.length * 0.5));
  const lastOrigin = closes.length - horizon;
  const first = Math.max(minTrain, lastOrigin - K * Math.max(1, Math.floor(horizon / 2)));
  const step = Math.max(1, Math.floor((lastOrigin - first) / K));

  const errs: number[][] = Array.from({ length: horizon }, () => []);
  let absModel = 0, absNaive = 0, n = 0;
  for (let t = first; t <= lastOrigin && n < K; t += step) {
    const f = await forecaster(closes.slice(0, t), horizon);
    if (f.length < horizon || f.some((v) => !Number.isFinite(v) || (useLog && v <= 0))) continue;
    for (let i = 0; i < horizon; i++) errs[i].push(tx(closes[t + i]) - tx(f[i]));
    absModel += Math.abs(f[horizon - 1] - closes[t + horizon - 1]);
    absNaive += Math.abs(closes[t - 1] - closes[t + horizon - 1]);
    n++;
  }

  const point = await forecaster(closes, horizon);
  if (point.length < horizon || point.some((v) => !Number.isFinite(v))) throw new Error(`${modelName} returned an invalid forecast`);
  const fdates = nextDates(dates, horizon);
  const enough = errs[0].length >= 10;
  const band = (i: number, q: number): number | null => {
    if (!enough) return null;
    const s = [...errs[i]].sort((a, b) => a - b);
    return quantile(s, q);
  };
  const forecast: ForecastPoint[] = point.map((v, i) => {
    const lo = band(i, 0.1), hi = band(i, 0.9);
    const base = tx(v);
    return { date: fdates[i], p50: v, p10: lo === null ? null : inv(base + lo), p90: hi === null ? null : inv(base + hi) };
  });
  const last = closes[closes.length - 1];
  const baseline: ForecastPoint[] = fdates.map((date) => ({ date, p50: last, p10: null, p90: null }));

  const mae = n ? absModel / n : NaN;
  const naiveMae = n ? absNaive / n : NaN;
  return {
    model: modelName,
    forecast,
    baseline,
    evaluation: n ? { origins: n, horizon, mae, naiveMae, skill: naiveMae ? 1 - mae / naiveMae : 0 } : null,
    note: enough ? undefined : 'Too few out-of-sample origins for empirical bands; showing point forecast only.',
  };
}

export async function runBuiltinModel(id: string, bars: Bar[], horizon: number): Promise<ForecastResult> {
  const fn = FNS[id];
  const meta = BUILTIN_MODELS.find((m) => m.id === id);
  if (!fn || !meta) throw new Error(`Unknown built-in model: ${id}`);
  const m = seasonPeriod(inferFrequency(bars.map((b) => b.date)));
  const positive = bars.every((b) => b.close > 0);
  return evaluateForecaster(meta.name, bars, horizon, (closes, h) =>
    positive ? fn(closes.map(Math.log), h, m).map(Math.exp) : fn(closes, h, m));
}
