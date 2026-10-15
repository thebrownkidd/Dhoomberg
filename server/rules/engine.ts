import { randomUUID } from 'node:crypto';
import type { BacktestResult, Bar, Condition, Group, Operand, OrderIntent, Rule, RuleAction } from '../../shared/types';
import type { DB } from '../db';
import { audit, emit } from '../events';
import { short } from '../http';
import type { Market } from '../market';
import { isMarketOpen } from '../orders/guard';
import type { Executor } from '../orders/executor';
import type { ActionImpl, ActionMessage } from '../plugins/types';
import type { PyBridge } from '../pybridge';
import type { Registry } from '../registry';
import { biasScore, demandData, indicatorSeries, type AnalystService, type ModelService, type NewsService } from '../services';
import { conditions, evalCondition, evalGroup, operandLabel, primaryInstrument, valueAt, type CondEval, type Resolved } from './evaluate';

type State = { lastEval?: string; lastResult?: boolean; lastFire?: string; lastBar?: string; prev?: Record<string, { left: number | null; right: number | null }>; lastError?: string | null };

export type Deps = { db: DB; reg: Registry; market: Market; py: PyBridge | null; news: NewsService; models: ModelService; analyst: AnalystService; executor: Executor };

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function validateRule(r: Partial<Rule>): Rule {
  if (!r.name?.trim()) throw new Error('Rule needs a name');
  if (!r.when || r.when.kind !== 'group' || !r.when.items?.length) throw new Error('Rule needs at least one condition');
  const conds = conditions(r.when);
  for (const c of conds) {
    if (!c.left || !c.right || !c.op) throw new Error('Every condition needs a left operand, operator and right operand');
    if (c.op === 'between' && c.upper === undefined) throw new Error('"between" needs an upper bound');
  }
  if (!primaryInstrument(r.when) && conds.some((c) => c.left.type === 'price' || c.left.type === 'indicator')) throw new Error('Rule needs an instrument');
  const mode = r.mode ?? 'notify';
  if (!['notify', 'confirm', 'auto'].includes(mode)) throw new Error('Invalid execution mode');
  for (const a of r.actions ?? []) {
    if (a.type === 'order') {
      if (!a.connectionId || !a.instrument) throw new Error('Order actions need a broker and an instrument');
      if (!(Number(a.qty) > 0) && !(Number(a.notional) > 0)) throw new Error('Order actions need a quantity or a notional');
    } else if (!a.connectionId) throw new Error('Notify actions need a connection');
  }
  const now = new Date().toISOString();
  return {
    id: r.id || `rule_${randomUUID().slice(0, 8)}`, name: r.name.trim(), enabled: !!r.enabled, when: r.when,
    cadence: r.cadence ?? { type: 'tick' }, cooldownMin: Math.max(0, Number(r.cooldownMin ?? 60)), activeHours: r.activeHours ?? null,
    mode, actions: r.actions ?? [], createdAt: r.createdAt ?? now, updatedAt: now,
  };
}

export class RuleEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private d: Deps) {}

  // ── Storage ────────────────────────────────────────────────────────────────
  list(): (Rule & { state: State })[] {
    return (this.d.db.prepare('SELECT json, state FROM rules').all() as { json: string; state: string | null }[])
      .map((r) => ({ ...(JSON.parse(r.json) as Rule), state: r.state ? JSON.parse(r.state) : {} }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Rule {
    const r = this.d.db.prepare('SELECT json FROM rules WHERE id = ?').get(id) as { json: string } | undefined;
    if (!r) throw new Error(`Unknown rule ${id}`);
    return JSON.parse(r.json);
  }

  save(input: Partial<Rule>): Rule {
    const rule = validateRule(input);
    const existed = !!this.d.db.prepare('SELECT 1 FROM rules WHERE id = ?').get(rule.id);
    this.d.db.prepare('INSERT INTO rules (id, json, state) VALUES (?, ?, NULL) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(rule.id, JSON.stringify(rule));
    audit(this.d.db, existed ? 'rule_updated' : 'rule_created', { rule }, rule.id);
    return rule;
  }

  remove(id: string) {
    this.d.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    audit(this.d.db, 'rule_deleted', {}, id);
  }

  private setState(id: string, s: State) {
    this.d.db.prepare('UPDATE rules SET state = ? WHERE id = ?').run(JSON.stringify(s), id);
  }

  // ── Operands ───────────────────────────────────────────────────────────────
  private async resolve(o: Operand, baseDates: string[], baseBars: Map<string, Bar[]>): Promise<Resolved> {
    const label = operandLabel(o);
    const align = (dates: string[], vals: (number | null)[]) => {
      const m = new Map(dates.map((d, i) => [d, vals[i]]));
      let last: number | null = null;
      return baseDates.map((d) => { const v = m.get(d); if (v !== undefined && v !== null) last = v; return m.has(d) ? v ?? null : last; });
    };
    const bars = async (id: string) => {
      if (!baseBars.has(id)) baseBars.set(id, await this.d.market.seriesWithQuote(id));
      return baseBars.get(id)!;
    };
    switch (o.type) {
      case 'const': return { series: null, scalar: Number(o.value), historical: true, label };
      case 'price': {
        const b = await bars(o.instrument);
        return { series: align(b.map((x) => x.date), b.map((x) => x.close)), scalar: null, historical: true, label };
      }
      case 'indicator': {
        const b = await bars(o.instrument);
        const r = await indicatorSeries(this.d.market, this.d.py, this.d.reg, o.instrument, o.indicator, o.params, b);
        const out = r.outputs[o.output || 'value'] ?? Object.values(r.outputs)[0];
        if (!out) throw new Error(`${label}: indicator returned no output`);
        return { series: align(r.dates, out), scalar: null, historical: true, label };
      }
      case 'model': {
        const f = await this.d.models.run(o.model, o.instrument, o.horizon);
        const b = await bars(o.instrument);
        const last = b[b.length - 1].close;
        return { series: null, scalar: (f.forecast[f.forecast.length - 1].p50 / last - 1) * 100, historical: false, label };
      }
      case 'news': {
        const s = await this.d.news.stats(o.instrument, o.windowHours);
        const v = o.field === 'sentiment_avg' ? s.sentimentAvg : o.field === 'bullish_count' ? s.bullish : s.bearish;
        return { series: null, scalar: v, historical: false, label };
      }
      case 'llm': {
        const v = await this.d.analyst.view(o.connectionId, o.instrument);
        return { series: null, scalar: biasScore(v), historical: false, label: `${label} (${v.bias} ${Math.round(v.confidence * 100)}%)` };
      }
      case 'demand': {
        const d = demandData();
        return { series: null, scalar: d?.series[o.series]?.latest ?? null, historical: false, label };
      }
      case 'cot': {
        const d = demandData();
        return { series: null, scalar: d?.cot[o.instrument]?.netLongPct ?? null, historical: false, label };
      }
    }
  }

  private async resolveAll(g: Group, baseId: string | null) {
    const baseBars = new Map<string, Bar[]>();
    const baseDates = baseId ? (await this.d.market.seriesWithQuote(baseId)).map((b) => b.date) : [new Date().toISOString().slice(0, 10)];
    if (baseId) baseBars.set(baseId, await this.d.market.seriesWithQuote(baseId));
    const resolved = new Map<Condition, { L: Resolved; R: Resolved }>();
    for (const c of conditions(g)) resolved.set(c, { L: await this.resolve(c.left, baseDates, baseBars), R: await this.resolve(c.right, baseDates, baseBars) });
    return { baseDates, baseBars, resolved };
  }

  // ── Live evaluation ────────────────────────────────────────────────────────
  async evaluate(rule: Rule, state: State = {}): Promise<{ result: boolean; details: CondEval[]; bar: string; price: number | null; prev: State['prev'] }> {
    const baseId = primaryInstrument(rule.when);
    const { baseDates, baseBars, resolved } = await this.resolveAll(rule.when, baseId);
    const i = baseDates.length - 1;
    const prev: NonNullable<State['prev']> = {};
    const { result, details } = evalGroup(rule.when, (c, path) => {
      const { L, R } = resolved.get(c)!;
      const r = evalCondition(c, L, R, i, state.prev?.[path]);
      prev[path] = { left: valueAt(L, i), right: valueAt(R, i) };
      return r;
    });
    const price = baseId ? baseBars.get(baseId)!.at(-1)?.close ?? null : null;
    return { result, details, bar: baseDates[i], price, prev };
  }

  private due(rule: Rule, s: State, now: number): boolean {
    if (rule.activeHours) {
      const ah = rule.activeHours;
      const days = ah.days.map((d) => DAY[d]).join(',');
      if (days && !isMarketOpen(`${days} ${ah.start}-${ah.end} ${ah.tz}`, new Date(now))) return false;
    }
    if (rule.cadence.type === 'interval') return !s.lastEval || now - Date.parse(s.lastEval) >= rule.cadence.minutes * 60_000;
    return true;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      this.d.executor.expireApprovals();
      await this.d.executor.sweepPaper();
      for (const rule of this.list().filter((r) => r.enabled)) {
        const s = rule.state;
        const now = Date.now();
        try {
          if (!this.due(rule, s, now)) continue;
          const ev = await this.evaluate(rule, s);
          const next: State = { ...s, lastEval: new Date(now).toISOString(), lastResult: ev.result, prev: ev.prev, lastError: null };
          if (rule.cadence.type === 'bar' && s.lastBar === ev.bar && s.lastResult !== undefined) { next.lastResult = s.lastResult; this.setState(rule.id, next); continue; }
          next.lastBar = ev.bar;
          const rising = ev.result && !s.lastResult;
          const cooled = !s.lastFire || now - Date.parse(s.lastFire) >= rule.cooldownMin * 60_000;
          if (rising && cooled) {
            next.lastFire = new Date(now).toISOString();
            this.setState(rule.id, next);
            await this.fire(rule, ev);
          } else {
            this.setState(rule.id, next);
          }
        } catch (e) {
          if (s.lastError !== short(e)) audit(this.d.db, 'rule_error', { error: short(e) }, rule.id);
          this.setState(rule.id, { ...s, lastEval: new Date(now).toISOString(), lastError: short(e) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 15_000) {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[rules]', e)), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Firing ─────────────────────────────────────────────────────────────────
  async fire(rule: Rule, ev: { details: CondEval[]; bar: string; price: number | null }, manual = false) {
    const fmt = (v: number | null) => (v === null ? 'n/a' : Math.abs(v) >= 100 ? v.toFixed(2) : v.toPrecision(4));
    const lines = ev.details.map((d) => `• ${d.label}: ${fmt(d.left)} vs ${fmt(d.right)} → ${d.result === null ? 'no data' : d.result ? 'true' : 'false'}`);
    audit(this.d.db, 'rule_fired', { rule: rule.name, bar: ev.bar, price: ev.price, conditions: ev.details, manual }, rule.id);

    const orderNotes: string[] = [];
    for (const [idx, a] of rule.actions.entries()) {
      if (a.type !== 'order') continue;
      try {
        orderNotes.push(await this.handleOrder(rule, a, idx, ev.bar));
      } catch (e) {
        orderNotes.push(`Order action failed: ${short(e)}`);
        audit(this.d.db, 'order_action_failed', { error: short(e), action: a }, rule.id);
      }
    }

    const msg: ActionMessage = {
      title: `${rule.name}`,
      body: [`Rule fired on ${ev.bar}${ev.price !== null ? ` at ${ev.price}` : ''}.`, ...lines, ...orderNotes].join('\n'),
      severity: rule.actions.some((a) => a.type === 'order') ? 'warning' : 'info',
      data: { rule: rule.name, ruleId: rule.id, instrument: primaryInstrument(rule.when), price: ev.price, bar: ev.bar, conditions: ev.details, orders: orderNotes },
    };
    for (const a of rule.actions) {
      if (a.type !== 'notify') continue;
      try {
        const impl = this.d.reg.plugin(a.connectionId).impl as ActionImpl;
        const res = await impl.send(this.d.reg.ctx(a.connectionId), msg);
        audit(this.d.db, 'notify_sent', { connectionId: a.connectionId, result: res }, rule.id);
      } catch (e) {
        audit(this.d.db, 'notify_failed', { connectionId: a.connectionId, error: short(e) }, rule.id);
      }
    }
    emit({ type: 'orders' });
  }

  private async handleOrder(rule: Rule, a: Extract<RuleAction, { type: 'order' }>, idx: number, bar: string): Promise<string> {
    const inst = this.d.market.instrument(a.instrument);
    const q = await this.d.market.quote(inst.id, 0);
    let qty = Number(a.qty);
    if (!(qty > 0)) {
      qty = Math.floor(Number(a.notional) / (q.price * inst.multiplier));
      if (qty < 1) throw new Error(`Notional ${a.notional} buys less than one unit at ${q.price}`);
    }
    const lp = a.orderType === 'limit' ? q.price * (1 + ((a.side === 'buy' ? -1 : 1) * Number(a.limitOffsetPct ?? 0)) / 100) : undefined;
    const bucket = rule.cadence.type === 'bar' ? bar : new Date().toISOString().slice(0, 16);
    const intent: OrderIntent = {
      connectionId: a.connectionId, instrument: inst.id, symbol: a.symbol || inst.symbol, side: a.side, qty,
      orderType: a.orderType, limitPrice: lp === undefined ? undefined : Number(lp.toFixed(Math.max(inst.dp, 2))), tif: a.tif,
      ruleId: rule.id, idemKey: `${rule.id}:${idx}:${bucket}`,
    };
    const desc = `${a.side.toUpperCase()} ${qty} ${inst.id}${intent.limitPrice ? ` LMT ${intent.limitPrice}` : ' MKT'}`;
    if (rule.mode === 'notify') {
      audit(this.d.db, 'order_suggested', { intent }, rule.id);
      return `Suggested order (notify-only rule, not placed): ${desc}`;
    }
    const brokerCfg = this.d.reg.ctx(a.connectionId).config;
    if (rule.mode === 'auto' && brokerCfg.allowAuto) {
      const o = await this.d.executor.submit(intent, 'auto', rule.name);
      return o.status === 'rejected' ? `Order REJECTED by risk guard: ${desc}. ${o.reason}` : `Order ${o.status}: ${desc} (${o.mode})`;
    }
    if (rule.mode === 'auto') audit(this.d.db, 'auto_downgraded', { reason: 'Broker does not allow auto execution', intent }, rule.id);
    const apv = this.d.executor.requestApproval(intent, q.price, rule.id, rule.name);
    return `Approval needed: ${desc}. Type APPROVE ${apv.id} in the terminal (expires in ${this.d.executor.limits().approvalTtlMin} min).`;
  }

  // ── Backtest ───────────────────────────────────────────────────────────────
  async backtest(rule: Rule, horizonBars = 5): Promise<BacktestResult> {
    const baseId = primaryInstrument(rule.when);
    if (!baseId) throw new Error('Backtests need at least one price or indicator condition');
    const { baseDates, baseBars, resolved } = await this.resolveAll(rule.when, baseId);
    const closes = baseBars.get(baseId)!.map((b) => b.close);
    const skipped = new Set<string>();
    for (const [, { L, R }] of resolved) for (const x of [L, R]) if (!x.historical) skipped.add(x.label);

    const fires: { date: string; price: number; i: number }[] = [];
    let prevResult = false;
    let lastFireT = -Infinity;
    for (let i = 1; i < baseDates.length; i++) {
      const { result } = evalGroup(rule.when, (c) => {
        const { L, R } = resolved.get(c)!;
        if (!L.historical || !R.historical) return { result: rule.when.mode === 'all', left: null, right: null, label: '' };
        return evalCondition(c, L, R, i);
      });
      const t = Date.parse(baseDates[i].length === 7 ? `${baseDates[i]}-01` : baseDates[i]);
      if (result && !prevResult && t - lastFireT >= rule.cooldownMin * 60_000) {
        fires.push({ date: baseDates[i], price: closes[i], i });
        lastFireT = t;
      }
      prevResult = result;
    }

    const orderAction = rule.actions.find((a) => a.type === 'order') as Extract<RuleAction, { type: 'order' }> | undefined;
    const dir = orderAction?.side === 'sell' ? -1 : 1;
    const fwd = (i: number) => (i + horizonBars < closes.length ? (closes[i + horizonBars] / closes[i] - 1) * 100 * dir : null);
    const rets = fires.map((f) => fwd(f.i)).filter((v): v is number => v !== null);
    const all = closes.map((_, i) => fwd(i)).filter((v): v is number => v !== null);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const mid = Math.floor(closes.length / 2);
    const half = (pred: (i: number) => boolean) => mean(fires.filter((f) => pred(f.i)).map((f) => fwd(f.i)).filter((v): v is number => v !== null));

    const notes = [
      'In-sample: if you chose these thresholds while looking at this chart, the result is fitted to it. Treat it as a sanity check, not evidence of an edge.',
      'Returns ignore costs, slippage and position sizing.',
    ];
    if (skipped.size) notes.unshift(`Not backtestable (no history): ${[...skipped].join('; ')}. Those conditions were assumed ${rule.when.mode === 'all' ? 'true' : 'false'}, so the fire count is ${rule.when.mode === 'all' ? 'overstated' : 'understated'}.`);
    if (rets.length < 20) notes.unshift(`Only ${rets.length} fires with a full ${horizonBars}-bar outcome: too few to conclude anything.`);

    return {
      ruleId: rule.id, instrument: baseId, bars: baseDates.length,
      fires: fires.map(({ date, price }) => ({ date, price })),
      skippedConditions: [...skipped],
      forwardReturn: {
        horizonBars, direction: dir === 1 ? 'long' : 'short', n: rets.length,
        avg: mean(rets), hitRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : null,
        baselineAvg: mean(all), firstHalfAvg: half((i) => i < mid), secondHalfAvg: half((i) => i >= mid),
      },
      note: notes.join(' '),
    };
  }
}
