// Built-in technical indicators. Pure functions over close prices; warm-up values are null.
// Conventions follow TA-Lib: EMA is seeded with the SMA of the first `n` values, RSI uses
// Wilder smoothing, Bollinger uses population standard deviation.

export type Series = (number | null)[];
export type IndicatorOutput = Record<string, Series>;

export type ParamSpec = { key: string; label: string; default: number; min: number; max: number; step?: number };

export type IndicatorMeta = {
  id: string;
  name: string;
  group: 'Trend' | 'Momentum' | 'Volatility' | 'Relative';
  pane: 'overlay' | 'sub';
  params: ParamSpec[];
  outputs: string[];
  needsOther?: boolean;           // takes a second instrument (correlation, ratio)
  levels?: number[];              // reference lines for sub-pane (e.g. RSI 30/70)
  description: string;
};

const nulls = (n: number): Series => new Array(n).fill(null);

export function sma(x: number[], n: number): Series {
  const out = nulls(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(x: number[], n: number): Series {
  const out = nulls(x.length);
  if (x.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += x[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < x.length; i++) {
    prev = x[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// EMA over a series that starts with nulls (e.g. MACD line → signal line).
function emaFrom(x: Series, n: number): Series {
  const first = x.findIndex((v) => v !== null);
  const out = nulls(x.length);
  if (first < 0) return out;
  const tail = ema(x.slice(first) as number[], n);
  for (let i = 0; i < tail.length; i++) out[first + i] = tail[i];
  return out;
}

export function wma(x: number[], n: number): Series {
  const out = nulls(x.length);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < x.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += x[i - n + 1 + j] * (j + 1);
    out[i] = s / denom;
  }
  return out;
}

function rollingStd(x: number[], n: number, ddof: 0 | 1): Series {
  const out = nulls(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let m = 0;
    for (let j = i - n + 1; j <= i; j++) m += x[j];
    m /= n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (x[j] - m) ** 2;
    out[i] = Math.sqrt(v / (n - ddof));
  }
  return out;
}

export function bollinger(x: number[], n: number, k: number): IndicatorOutput {
  const mid = sma(x, n);
  const sd = rollingStd(x, n, 0);
  return {
    mid,
    upper: mid.map((m, i) => (m === null ? null : m + k * sd[i]!)),
    lower: mid.map((m, i) => (m === null ? null : m - k * sd[i]!)),
  };
}

export function rsi(x: number[], n: number): Series {
  const out = nulls(x.length);
  if (x.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = x[i] - x[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(x: number[], fast: number, slow: number, signal: number): IndicatorOutput {
  const f = ema(x, fast);
  const s = ema(x, slow);
  const line: Series = x.map((_, i) => (f[i] === null || s[i] === null ? null : f[i]! - s[i]!));
  const sig = emaFrom(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]!)) };
}

export function roc(x: number[], n: number): Series {
  return x.map((v, i) => (i < n ? null : (v / x[i - n] - 1) * 100));
}

export function zscore(x: number[], n: number): Series {
  const m = sma(x, n);
  const sd = rollingStd(x, n, 0);
  return x.map((v, i) => (m[i] === null || !sd[i] ? null : (v - m[i]!) / sd[i]!));
}

export function rollingVol(x: number[], n: number, periodsPerYear: number): Series {
  const rets = x.map((v, i) => (i === 0 ? 0 : Math.log(v / x[i - 1])));
  const out = nulls(x.length);
  const sd = rollingStd(rets.slice(1), n, 1);
  for (let i = 0; i < sd.length; i++) out[i + 1] = sd[i] === null ? null : sd[i]! * Math.sqrt(periodsPerYear) * 100;
  return out;
}

export function percentRank(x: number[], n: number): Series {
  return x.map((v, i) => {
    if (i < n - 1) return null;
    let c = 0;
    for (let j = i - n + 1; j <= i; j++) if (x[j] <= v) c++;
    return (c / n) * 100;
  });
}

export function donchian(x: number[], n: number): IndicatorOutput {
  const upper = nulls(x.length), lower = nulls(x.length), mid = nulls(x.length);
  for (let i = n - 1; i < x.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, x[j]); lo = Math.min(lo, x[j]); }
    upper[i] = hi; lower[i] = lo; mid[i] = (hi + lo) / 2;
  }
  return { upper, mid, lower };
}

// Close-only data has no high/low, so the "ATR" here is an EMA of absolute close-to-close moves.
export function keltner(x: number[], n: number, mult: number): IndicatorOutput {
  const mid = ema(x, n);
  const moves = x.map((v, i) => (i === 0 ? 0 : Math.abs(v - x[i - 1])));
  const atr = emaFrom([null, ...moves.slice(1)], n);
  return {
    mid,
    upper: mid.map((m, i) => (m === null || atr[i] === null ? null : m + mult * atr[i]!)),
    lower: mid.map((m, i) => (m === null || atr[i] === null ? null : m - mult * atr[i]!)),
  };
}

export function linregChannel(x: number[], n: number, k: number): IndicatorOutput {
  const mid = nulls(x.length), upper = nulls(x.length), lower = nulls(x.length);
  const xm = (n - 1) / 2;
  let sxx = 0;
  for (let j = 0; j < n; j++) sxx += (j - xm) ** 2;
  for (let i = n - 1; i < x.length; i++) {
    let ym = 0;
    for (let j = 0; j < n; j++) ym += x[i - n + 1 + j];
    ym /= n;
    let sxy = 0;
    for (let j = 0; j < n; j++) sxy += (j - xm) * (x[i - n + 1 + j] - ym);
    const b = sxy / sxx, a = ym - b * xm;
    let r = 0;
    for (let j = 0; j < n; j++) r += (x[i - n + 1 + j] - (a + b * j)) ** 2;
    const se = Math.sqrt(r / Math.max(n - 2, 1));
    const fit = a + b * (n - 1);
    mid[i] = fit; upper[i] = fit + k * se; lower[i] = fit - k * se;
  }
  return { mid, upper, lower };
}

export function rollingCorr(x: number[], y: number[], n: number): Series {
  const rx = x.map((v, i) => (i === 0 ? 0 : Math.log(v / x[i - 1])));
  const ry = y.map((v, i) => (i === 0 ? 0 : Math.log(v / y[i - 1])));
  return x.map((_, i) => {
    if (i < n) return null;
    let mx = 0, my = 0;
    for (let j = i - n + 1; j <= i; j++) { mx += rx[j]; my += ry[j]; }
    mx /= n; my /= n;
    let num = 0, dx = 0, dy = 0;
    for (let j = i - n + 1; j <= i; j++) {
      num += (rx[j] - mx) * (ry[j] - my); dx += (rx[j] - mx) ** 2; dy += (ry[j] - my) ** 2;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  });
}

// ── Registry ─────────────────────────────────────────────────────────────────
const P = (key: string, label: string, def: number, min: number, max: number, step = 1): ParamSpec => ({ key, label, default: def, min, max, step });

export const INDICATORS: IndicatorMeta[] = [
  { id: 'sma', name: 'SMA', group: 'Trend', pane: 'overlay', params: [P('period', 'Period', 20, 2, 500)], outputs: ['value'], description: 'Simple moving average' },
  { id: 'ema', name: 'EMA', group: 'Trend', pane: 'overlay', params: [P('period', 'Period', 20, 2, 500)], outputs: ['value'], description: 'Exponential moving average (SMA-seeded)' },
  { id: 'wma', name: 'WMA', group: 'Trend', pane: 'overlay', params: [P('period', 'Period', 20, 2, 500)], outputs: ['value'], description: 'Linearly weighted moving average' },
  { id: 'bbands', name: 'Bollinger Bands', group: 'Volatility', pane: 'overlay', params: [P('period', 'Period', 20, 2, 500), P('k', 'Std devs', 2, 0.5, 5, 0.1)], outputs: ['upper', 'mid', 'lower'], description: 'SMA ± k population std devs' },
  { id: 'donchian', name: 'Donchian Channel', group: 'Volatility', pane: 'overlay', params: [P('period', 'Period', 20, 2, 500)], outputs: ['upper', 'mid', 'lower'], description: 'Highest / lowest close over the window' },
  { id: 'keltner', name: 'Keltner Channel', group: 'Volatility', pane: 'overlay', params: [P('period', 'Period', 20, 2, 500), P('mult', 'Multiplier', 2, 0.5, 5, 0.1)], outputs: ['upper', 'mid', 'lower'], description: 'EMA ± mult × close-based ATR proxy' },
  { id: 'linreg', name: 'Regression Channel', group: 'Trend', pane: 'overlay', params: [P('period', 'Period', 50, 5, 500), P('k', 'Std errs', 2, 0.5, 5, 0.1)], outputs: ['upper', 'mid', 'lower'], description: 'Rolling linear fit ± k standard errors' },
  { id: 'rsi', name: 'RSI', group: 'Momentum', pane: 'sub', params: [P('period', 'Period', 14, 2, 100)], outputs: ['value'], levels: [30, 70], description: 'Wilder relative strength index' },
  { id: 'macd', name: 'MACD', group: 'Momentum', pane: 'sub', params: [P('fast', 'Fast', 12, 2, 100), P('slow', 'Slow', 26, 3, 200), P('signal', 'Signal', 9, 2, 50)], outputs: ['macd', 'signal', 'hist'], levels: [0], description: 'EMA(fast) − EMA(slow) with signal line' },
  { id: 'roc', name: 'Rate of Change', group: 'Momentum', pane: 'sub', params: [P('period', 'Period', 10, 1, 250)], outputs: ['value'], levels: [0], description: '% change over N bars' },
  { id: 'zscore', name: 'Z-Score', group: 'Momentum', pane: 'sub', params: [P('period', 'Period', 20, 5, 500)], outputs: ['value'], levels: [-2, 0, 2], description: 'Distance from the rolling mean in std devs' },
  { id: 'vol', name: 'Realised Vol', group: 'Volatility', pane: 'sub', params: [P('period', 'Period', 20, 5, 500), P('ppy', 'Bars / year', 252, 1, 365)], outputs: ['value'], description: 'Annualised std dev of log returns, %' },
  { id: 'prank', name: 'Percentile Rank', group: 'Momentum', pane: 'sub', params: [P('period', 'Period', 252, 10, 2000)], outputs: ['value'], levels: [10, 90], description: 'Where the close sits within its window, 0–100' },
  { id: 'corr', name: 'Rolling Correlation', group: 'Relative', pane: 'sub', params: [P('period', 'Period', 60, 10, 500)], outputs: ['value'], needsOther: true, levels: [0], description: 'Correlation of log returns vs another instrument' },
  { id: 'ratio', name: 'Price Ratio', group: 'Relative', pane: 'sub', params: [], outputs: ['value'], needsOther: true, description: 'This instrument ÷ another instrument' },
];

export function indicatorMeta(id: string): IndicatorMeta | undefined {
  return INDICATORS.find((m) => m.id === id);
}

export function computeIndicator(id: string, closes: number[], params: Record<string, number | string>, other?: number[]): IndicatorOutput {
  const meta = indicatorMeta(id);
  if (!meta) throw new Error(`Unknown indicator: ${id}`);
  const p = (k: string) => {
    const spec = meta.params.find((s) => s.key === k)!;
    const v = Number(params[k] ?? spec.default);
    return Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.default;
  };
  if (meta.needsOther && (!other || other.length !== closes.length)) throw new Error(`${meta.name} needs a second instrument aligned to the same dates`);
  switch (id) {
    case 'sma': return { value: sma(closes, p('period')) };
    case 'ema': return { value: ema(closes, p('period')) };
    case 'wma': return { value: wma(closes, p('period')) };
    case 'bbands': return bollinger(closes, p('period'), p('k'));
    case 'donchian': return donchian(closes, p('period'));
    case 'keltner': return keltner(closes, p('period'), p('mult'));
    case 'linreg': return linregChannel(closes, p('period'), p('k'));
    case 'rsi': return { value: rsi(closes, p('period')) };
    case 'macd': return macd(closes, p('fast'), p('slow'), p('signal'));
    case 'roc': return { value: roc(closes, p('period')) };
    case 'zscore': return { value: zscore(closes, p('period')) };
    case 'vol': return { value: rollingVol(closes, p('period'), p('ppy')) };
    case 'prank': return { value: percentRank(closes, p('period')) };
    case 'corr': return { value: rollingCorr(closes, other!, p('period')) };
    case 'ratio': return { value: closes.map((v, i) => (other![i] ? v / other![i] : null)) };
    default: throw new Error(`Unknown indicator: ${id}`);
  }
}
