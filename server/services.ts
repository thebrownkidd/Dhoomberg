import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeIndicator, indicatorMeta, rsi } from '../shared/indicators';
import { BUILTIN_MODELS, evaluateForecaster, runBuiltinModel } from '../shared/models';
import type { Bar, ForecastResult, LlmView, NewsItem } from '../shared/types';
import { short } from './http';
import type { Market } from './market';
import type { NewsImpl, ModelImpl } from './plugins/types';
import type { PyBridge } from './pybridge';
import type { Registry } from './registry';
import { PUBLIC_DIR } from './paths';

// ── News ─────────────────────────────────────────────────────────────────────
export class NewsService {
  private cache = new Map<string, { at: number; items: Promise<NewsItem[]> }>();
  errors: Record<string, string> = {};

  constructor(private reg: Registry) {}

  private demo(): NewsItem[] {
    const f = join(PUBLIC_DIR, 'news', 'news.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).items as NewsItem[]) : [];
  }

  async items(opts: { connectionId?: string; query?: string; ttlMs?: number } = {}): Promise<{ items: NewsItem[]; sources: string[]; demo: boolean }> {
    const conns = this.reg.list('news').filter((c) => c.enabled && (!opts.connectionId || c.id === opts.connectionId));
    if (!conns.length) return { items: this.demo(), sources: ['Demo feed'], demo: true };
    const results = await Promise.all(conns.map(async (c) => {
      const key = `${c.id}|${opts.query ?? ''}`;
      const hit = this.cache.get(key);
      if (!hit || Date.now() - hit.at > (opts.ttlMs ?? 5 * 60_000)) {
        const impl = this.reg.plugin(c.id).impl as NewsImpl;
        this.cache.set(key, { at: Date.now(), items: impl.fetch(this.reg.ctx(c.id), { query: opts.query }) });
      }
      try {
        const items = await this.cache.get(key)!.items;
        delete this.errors[c.id];
        return items;
      } catch (e) {
        this.cache.delete(key);
        this.errors[c.id] = short(e);
        return [];
      }
    }));
    const seen = new Set<string>();
    const items = results.flat().filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    return { items: items.slice(0, 300), sources: conns.map((c) => c.name), demo: false };
  }

  async stats(instrument: string, windowHours: number): Promise<{ sentimentAvg: number | null; bullish: number; bearish: number; n: number }> {
    const { items } = await this.items();
    const since = Date.now() - windowHours * 3_600_000;
    const rel = items.filter((i) => Date.parse(i.publishedAt) >= since && i.commodities.includes(instrument));
    const scored = rel.filter((i) => i.sentimentScore !== null);
    return {
      sentimentAvg: scored.length ? scored.reduce((s, i) => s + i.sentimentScore!, 0) / scored.length : null,
      bullish: rel.filter((i) => i.sentiment === 'bullish').length,
      bearish: rel.filter((i) => i.sentiment === 'bearish').length,
      n: rel.length,
    };
  }
}

// ── Demand (output of research/ml_demand.py) ─────────────────────────────────
type DemandFile = { series: Record<string, { latest: number }>; cot: Record<string, { netLongPct: number }> };
export function demandData(): DemandFile | null {
  const f = join(PUBLIC_DIR, 'demand', 'demand.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

// ── Forecast models: built-in | py:<name> | <http_forecast connection id> ────
export type ModelOption = { id: string; name: string; source: 'builtin' | 'python' | 'connection'; description: string };

export class ModelService {
  private cache = new Map<string, { at: number; r: Promise<ForecastResult> }>();
  constructor(private reg: Registry, private market: Market, private py: PyBridge | null) {}

  options(): ModelOption[] {
    return [
      ...BUILTIN_MODELS.map((m) => ({ id: `builtin:${m.id}`, name: m.name, source: 'builtin' as const, description: m.description })),
      ...this.reg.pythonPlugins('model').map((p) => ({ id: `py:${p.name}`, name: p.title, source: 'python' as const, description: p.description })),
      ...this.reg.list('model').filter((c) => c.enabled && this.reg.plugin(c.id).capabilities?.forecast).map((c) => ({ id: c.id, name: c.name, source: 'connection' as const, description: 'Custom HTTP model' })),
    ];
  }

  async run(modelId: string, instrument: string, horizon: number): Promise<ForecastResult> {
    const h = Math.max(1, Math.min(60, Math.round(horizon)));
    const key = `${modelId}|${instrument}|${h}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.r;
    const r = this.compute(modelId, await this.market.series(instrument), h);
    this.cache.set(key, { at: Date.now(), r });
    r.catch(() => this.cache.delete(key));
    return r;
  }

  private compute(modelId: string, bars: Bar[], h: number): Promise<ForecastResult> {
    if (bars.length < 30) return Promise.reject(new Error(`Only ${bars.length} bars; models need at least 30`));
    if (modelId.startsWith('builtin:')) return runBuiltinModel(modelId.slice(8), bars, h);
    const dates = bars.map((b) => b.date);
    if (modelId.startsWith('py:')) {
      const name = modelId.slice(3);
      const p = this.reg.pythonPlugins('model').find((x) => x.name === name);
      if (!p || !this.py) return Promise.reject(new Error(`Python model ${name} is not loaded`));
      return evaluateForecaster(p.title, bars, h, (closes, hh) => this.py!.call<number[]>(name, { dates: dates.slice(0, closes.length), closes, horizon: hh, params: {} }, 60_000), { origins: 12 });
    }
    const conn = this.reg.connection(modelId);
    const impl = this.reg.plugin(modelId).impl as ModelImpl;
    if (!impl.forecast) return Promise.reject(new Error(`${conn.name} is not a forecast model`));
    const ctx = this.reg.ctx(modelId);
    return evaluateForecaster(conn.name, bars, h, (closes, hh) => impl.forecast!(ctx, closes, dates.slice(0, closes.length), hh), { origins: Number(ctx.config.evalOrigins ?? 8) });
  }
}

// ── LLM analyst ──────────────────────────────────────────────────────────────
const SYSTEM = `You are a commodity market analyst inside a trading terminal. You get recent price statistics,
technical readings and headlines for one instrument. Judge the short-term (1–4 week) price bias.
Answer with ONLY a JSON object: {"bias": "bullish"|"bearish"|"neutral", "confidence": number 0..1, "rationale": string under 60 words}.
Be calibrated: use "neutral" and low confidence when evidence is mixed or thin. Do not invent facts beyond the input.`;

export class AnalystService {
  private cache = new Map<string, { at: number; v: Promise<LlmView> }>();
  constructor(private reg: Registry, private market: Market, private news: NewsService) {}

  view(connectionId: string, instrument: string, maxAgeMs = 30 * 60_000): Promise<LlmView> {
    const key = `${connectionId}|${instrument}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.v;
    const v = this.ask(connectionId, instrument);
    this.cache.set(key, { at: Date.now(), v });
    v.catch(() => this.cache.delete(key));
    return v;
  }

  private async ask(connectionId: string, instrument: string): Promise<LlmView> {
    const impl = this.reg.plugin(connectionId).impl as ModelImpl;
    if (!impl.complete) throw new Error('That model connection is not a language model');
    const inst = this.market.instrument(instrument);
    const bars = await this.market.seriesWithQuote(instrument);
    const closes = bars.map((b) => b.close);
    const last = closes[closes.length - 1];
    const ch = (n: number) => (closes.length > n ? ((last / closes[closes.length - 1 - n] - 1) * 100).toFixed(2) + '%' : 'n/a');
    const r = rsi(closes, 14).at(-1);
    const bb = computeIndicator('bbands', closes, { period: 20, k: 2 });
    const { items } = await this.news.items();
    const heads = items.filter((i) => i.commodities.includes(inst.id)).slice(0, 12);
    const general = heads.length < 5 ? items.slice(0, 8 - heads.length) : [];
    const prompt = [
      `Instrument: ${inst.name} (${inst.id}), unit ${inst.unit}. Last price ${last} on ${bars.at(-1)!.date}.`,
      `Change: 5 bars ${ch(5)}, 20 bars ${ch(20)}, 60 bars ${ch(60)}, 250 bars ${ch(250)}.`,
      `RSI(14) ${r?.toFixed(1) ?? 'n/a'}. Bollinger(20,2): lower ${bb.lower.at(-1)?.toFixed(3)}, mid ${bb.mid.at(-1)?.toFixed(3)}, upper ${bb.upper.at(-1)?.toFixed(3)}.`,
      `Headlines tagged ${inst.id} (newest first):`,
      ...(heads.length ? heads.map((h) => `- [${h.publishedAt.slice(0, 10)} ${h.source}${h.sentiment ? ` ${h.sentiment}` : ''}] ${h.headline}`) : ['- none']),
      ...(general.length ? ['General commodity headlines:', ...general.map((h) => `- [${h.publishedAt.slice(0, 10)}] ${h.headline}`)] : []),
    ].join('\n');
    const text = await impl.complete(this.reg.ctx(connectionId), SYSTEM, prompt);
    return parseView(text, this.reg.connection(connectionId).name);
  }
}

export function parseView(text: string, model: string): LlmView {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`LLM did not return JSON: ${text.slice(0, 120)}`);
  let j: { bias?: string; confidence?: number; rationale?: string };
  try { j = JSON.parse(m[0]); } catch { throw new Error(`LLM returned malformed JSON: ${m[0].slice(0, 120)}`); }
  const bias = j.bias === 'bullish' || j.bias === 'bearish' || j.bias === 'neutral' ? j.bias : null;
  const confidence = Number(j.confidence);
  if (!bias || !Number.isFinite(confidence)) throw new Error(`LLM JSON missing bias/confidence: ${m[0].slice(0, 120)}`);
  return { bias, confidence: Math.max(0, Math.min(1, confidence)), rationale: String(j.rationale ?? '').slice(0, 500), model, at: new Date().toISOString() };
}

export function biasScore(v: LlmView): number {
  return v.bias === 'bullish' ? v.confidence : v.bias === 'bearish' ? -v.confidence : 0;
}

// ── Indicators: built-in (shared/) or py:<name> ──────────────────────────────
export async function indicatorSeries(
  market: Market, py: PyBridge | null, reg: Registry,
  instrument: string, indicator: string, params: Record<string, number | string>, bars?: Bar[],
): Promise<{ dates: string[]; outputs: Record<string, (number | null)[]> }> {
  const base = bars ?? (await market.seriesWithQuote(instrument));
  const dates = base.map((b) => b.date);
  const closes = base.map((b) => b.close);
  let other: number[] | undefined;
  const vs = typeof params.vs === 'string' ? params.vs : undefined;
  if (vs) {
    const ob = await market.seriesWithQuote(vs);
    const map = new Map(ob.map((b) => [b.date, b.close]));
    let lastV: number | undefined;
    other = dates.map((d) => (lastV = map.get(d) ?? lastV) ?? NaN);
  }
  if (indicator.startsWith('py:')) {
    const name = indicator.slice(3);
    if (!py || !reg.pythonPlugins('indicator').some((p) => p.name === name)) throw new Error(`Python indicator ${name} is not loaded`);
    const { vs: _vs, ...rest } = params;
    const outputs = await py.call<Record<string, (number | null)[]>>(name, { dates, closes, params: rest, other: other ?? null });
    return { dates, outputs };
  }
  if (!indicatorMeta(indicator)) throw new Error(`Unknown indicator ${indicator}`);
  return { dates, outputs: computeIndicator(indicator, closes, params, other) };
}
