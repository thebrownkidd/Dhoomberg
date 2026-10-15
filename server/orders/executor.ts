import { randomUUID } from 'node:crypto';
import { DEFAULT_RISK_LIMITS, type Account, type Approval, type OrderIntent, type OrderRecord, type Position, type RiskLimits } from '../../shared/types';
import { kvGet, kvSet, type DB } from '../db';
import { audit, emit } from '../events';
import { short } from '../http';
import type { Market } from '../market';
import { HOURS, paperFill } from '../plugins/brokers';
import type { BrokerImpl } from '../plugins/types';
import type { Registry } from '../registry';
import { checkOrder, isMarketOpen } from './guard';

type OrderRow = { json: string };

export class Executor {
  constructor(private db: DB, private reg: Registry, private market: Market) {}

  // ── State ──────────────────────────────────────────────────────────────────
  limits(): RiskLimits {
    return { ...DEFAULT_RISK_LIMITS, ...kvGet<Partial<RiskLimits>>(this.db, 'risk_limits', {}) };
  }

  setLimits(patch: Partial<RiskLimits>): RiskLimits {
    const cur = this.limits();
    const next = { ...cur };
    for (const k of Object.keys(DEFAULT_RISK_LIMITS) as (keyof RiskLimits)[]) {
      if (patch[k] === undefined) continue;
      const v = Number(patch[k]);
      if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`);
      next[k] = v;
    }
    kvSet(this.db, 'risk_limits', next);
    audit(this.db, 'risk_limits', { from: cur, to: next });
    return next;
  }

  halted(): boolean {
    return kvGet(this.db, 'halted', false);
  }

  private broker(connectionId: string): BrokerImpl {
    const p = this.reg.plugin(connectionId);
    if (p.kind !== 'broker') throw new Error(`${connectionId} is not a broker connection`);
    return p.impl;
  }

  mode(connectionId: string): 'paper' | 'live' {
    return this.broker(connectionId).isLive(this.reg.ctx(connectionId)) ? 'live' : 'paper';
  }

  liveArmed(connectionId: string): boolean {
    const b = this.broker(connectionId);
    const ctx = this.reg.ctx(connectionId);
    const acct = b.accountId(ctx);
    return b.isLive(ctx) && !!acct && kvGet<string | null>(this.db, `live_armed:${connectionId}`, null) === acct;
  }

  /** Arming live trading requires re-typing the broker account ID. */
  arm(connectionId: string, typedAccountId: string) {
    const b = this.broker(connectionId);
    const ctx = this.reg.ctx(connectionId);
    if (!b.isLive(ctx)) throw new Error('Set the connection environment to live first.');
    const acct = b.accountId(ctx);
    if (!acct) throw new Error('This connection has no account ID configured.');
    if (typedAccountId.trim() !== acct) throw new Error('Account ID does not match. Live trading NOT armed.');
    kvSet(this.db, `live_armed:${connectionId}`, acct);
    audit(this.db, 'live_armed', { connectionId, account: acct });
    emit({ type: 'connections' });
  }

  disarm(connectionId: string) {
    kvSet(this.db, `live_armed:${connectionId}`, null);
    audit(this.db, 'live_disarmed', { connectionId });
    emit({ type: 'connections' });
  }

  async halt(reason: string) {
    kvSet(this.db, 'halted', true);
    audit(this.db, 'halt', { reason });
    emit({ type: 'halt', halted: true });
    for (const c of this.reg.list('broker')) {
      try {
        const n = await this.broker(c.id).cancelAll(this.reg.ctx(c.id));
        audit(this.db, 'cancel_all', { connectionId: c.id, cancelled: n });
      } catch (e) {
        audit(this.db, 'cancel_all_failed', { connectionId: c.id, error: short(e) });
      }
    }
    for (const o of this.orders(500).filter((o) => o.status === 'open' && o.mode === 'paper')) this.updateOrder(o, { status: 'cancelled', reason: 'Cancelled by HALT' });
    for (const a of this.approvals('pending')) this.decide(a, 'rejected', 'Rejected by HALT');
    emit({ type: 'orders' });
  }

  resume() {
    kvSet(this.db, 'halted', false);
    audit(this.db, 'resume', {});
    emit({ type: 'halt', halted: false });
  }

  // ── Orders ─────────────────────────────────────────────────────────────────
  private todayStats(): { notional: number; count: number } {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const r = this.db.prepare("SELECT COALESCE(SUM(notional), 0) AS n, COUNT(*) AS c FROM orders WHERE created_at >= ? AND status NOT IN ('rejected', 'error', 'cancelled')").get(start.toISOString()) as { n: number; c: number };
    return { notional: r.n, count: r.c };
  }

  private async positionQty(connectionId: string, instrument: string, symbol: string): Promise<number> {
    try {
      const ps = await this.broker(connectionId).positions(this.reg.ctx(connectionId));
      return ps.find((p) => p.instrument === instrument || p.symbol === symbol)?.qty ?? 0;
    } catch {
      return 0;
    }
  }

  private save(o: OrderRecord) {
    this.db.prepare('INSERT INTO orders (id, idem_key, connection_id, instrument, mode, status, notional, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.id, o.status === 'rejected' ? `${o.idemKey}#rejected#${o.id}` : o.idemKey, o.connectionId, o.instrument, o.mode, o.status, o.notional, JSON.stringify(o), o.createdAt, o.updatedAt);
  }

  private updateOrder(o: OrderRecord, patch: Partial<OrderRecord>): OrderRecord {
    const next = { ...o, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE orders SET status = ?, json = ?, updated_at = ? WHERE id = ?').run(next.status, JSON.stringify(next), next.updatedAt, next.id);
    return next;
  }

  private lock: Promise<unknown> = Promise.resolve();

  /** The only path to a broker. Serialised so daily limits and duplicate checks can't race. */
  submit(intent: OrderIntent, execMode: 'manual' | 'confirm' | 'auto', ruleName?: string): Promise<OrderRecord> {
    const run = this.lock.then(() => this.submitLocked(intent, execMode, ruleName));
    this.lock = run.catch(() => {});
    return run;
  }

  private async submitLocked(intent: OrderIntent, execMode: 'manual' | 'confirm' | 'auto', ruleName?: string): Promise<OrderRecord> {
    const inst = this.market.instrument(intent.instrument);
    const conn = this.reg.connection(intent.connectionId);
    const ctx = this.reg.ctx(intent.connectionId);
    const mode = this.mode(intent.connectionId);
    const now = new Date();
    let refPrice = NaN, quoteTs = '', quoteErr: string | null = null;
    try {
      const q = await this.market.quote(inst.id, 0);
      refPrice = q.price; quoteTs = q.ts;
    } catch (e) {
      quoteErr = short(e);
    }
    let marketOpen = true, hoursErr: string | null = null;
    try { marketOpen = isMarketOpen(String(ctx.config.tradingHours ?? HOURS[conn.pluginId] ?? '24/7'), now); } catch (e) { marketOpen = false; hoursErr = short(e); }
    const stats = this.todayStats();
    const dup = !!this.db.prepare('SELECT 1 FROM orders WHERE idem_key = ?').get(intent.idemKey);
    const g = checkOrder({
      intent, refPrice, quoteTs, now, limits: this.limits(), halted: this.halted(), mode,
      liveArmed: mode === 'live' && this.liveArmed(intent.connectionId),
      sourceRealtime: this.market.isRealtime(inst), sourceName: inst.connectionId === 'demo' ? 'Demo' : this.reg.connection(inst.connectionId).name,
      execMode, autoAllowed: !!ctx.config.allowAuto, multiplier: inst.multiplier,
      todayNotional: stats.notional, todayCount: stats.count,
      positionQty: await this.positionQty(intent.connectionId, inst.id, intent.symbol),
      duplicate: dup, marketOpen,
    });
    if (quoteErr) g.reasons.unshift(`Quote failed: ${quoteErr}`);
    if (hoursErr) g.reasons.push(hoursErr);

    const base: OrderRecord = {
      ...intent, id: `ord_${randomUUID().slice(0, 12)}`, mode, status: 'rejected', notional: g.notional, refPrice,
      fillPrice: null, brokerOrderId: null, reason: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };

    if (!g.ok || quoteErr) {
      const rec = { ...base, reason: g.reasons.join(' ') };
      this.save(rec);
      audit(this.db, 'order_rejected', { order: rec, reasons: g.reasons, execMode, rule: ruleName ?? null }, intent.ruleId ?? null, rec.id);
      emit({ type: 'orders' });
      return rec;
    }

    let rec: OrderRecord = { ...base, status: 'submitted' };
    this.save(rec);
    audit(this.db, 'order_submitted', { order: rec, execMode, rule: ruleName ?? null, broker: conn.name }, intent.ruleId ?? null, rec.id);
    try {
      const placed = await this.broker(intent.connectionId).placeOrder(ctx, intent, refPrice);
      rec = this.updateOrder(rec, { status: placed.status, brokerOrderId: placed.brokerOrderId, fillPrice: placed.fillPrice ?? null, reason: placed.message ?? null });
      if (conn.pluginId === 'paper' && placed.status === 'filled') paperFill(ctx, inst.id, intent.symbol, intent.side, intent.qty, placed.fillPrice!, inst.multiplier);
      audit(this.db, placed.status === 'filled' ? 'order_filled' : 'order_accepted', { order: rec }, intent.ruleId ?? null, rec.id);
    } catch (e) {
      rec = this.updateOrder(rec, { status: 'error', reason: short(e) });
      audit(this.db, 'order_error', { order: rec, error: short(e) }, intent.ruleId ?? null, rec.id);
    }
    emit({ type: 'orders' });
    return rec;
  }

  /** Fills resting paper limit orders whose price has been reached. */
  async sweepPaper() {
    for (const o of this.orders(500).filter((x) => x.status === 'open' && x.mode === 'paper')) {
      let conn;
      try { conn = this.reg.connection(o.connectionId); } catch { continue; }
      if (conn.pluginId !== 'paper') continue;
      try {
        const q = await this.market.quote(o.instrument);
        const hit = o.side === 'buy' ? q.price <= o.limitPrice! : q.price >= o.limitPrice!;
        if (!hit) continue;
        const inst = this.market.instrument(o.instrument);
        paperFill(this.reg.ctx(o.connectionId), inst.id, o.symbol, o.side, o.qty, o.limitPrice!, inst.multiplier);
        const rec = this.updateOrder(o, { status: 'filled', fillPrice: o.limitPrice! });
        audit(this.db, 'order_filled', { order: rec }, o.ruleId ?? null, o.id);
        emit({ type: 'orders' });
      } catch { /* quote unavailable; try again next tick */ }
    }
  }

  orders(limit = 200): OrderRecord[] {
    return (this.db.prepare('SELECT json FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as OrderRow[]).map((r) => JSON.parse(r.json));
  }

  // ── Approvals ──────────────────────────────────────────────────────────────
  requestApproval(intent: OrderIntent, refPrice: number, ruleId: string | null, ruleName: string): Approval {
    const a: Approval = { id: `apv_${randomUUID().slice(0, 10)}`, ruleId, ruleName, intent, refPrice, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null, result: null };
    this.db.prepare('INSERT INTO approvals (id, json, status, created_at) VALUES (?, ?, ?, ?)').run(a.id, JSON.stringify(a), a.status, a.createdAt);
    audit(this.db, 'approval_requested', { approval: a }, ruleId, a.id);
    emit({ type: 'approvals' });
    return a;
  }

  approvals(status?: Approval['status']): Approval[] {
    this.expireApprovals();
    const rows = (status
      ? this.db.prepare('SELECT json FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status)
      : this.db.prepare('SELECT json FROM approvals ORDER BY created_at DESC LIMIT 200').all()) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json));
  }

  private decide(a: Approval, status: Approval['status'], result: string): Approval {
    const next = { ...a, status, decidedAt: new Date().toISOString(), result };
    this.db.prepare('UPDATE approvals SET json = ?, status = ? WHERE id = ?').run(JSON.stringify(next), status, a.id);
    audit(this.db, `approval_${status}`, { approval: next }, a.ruleId, a.id);
    emit({ type: 'approvals' });
    return next;
  }

  expireApprovals() {
    const ttl = this.limits().approvalTtlMin * 60_000;
    const rows = this.db.prepare("SELECT json FROM approvals WHERE status = 'pending'").all() as { json: string }[];
    for (const r of rows) {
      const a: Approval = JSON.parse(r.json);
      if (Date.now() - Date.parse(a.createdAt) > ttl) this.decide(a, 'expired', `Not approved within ${this.limits().approvalTtlMin} min`);
    }
  }

  private pending(id: string): Approval {
    this.expireApprovals();
    const row = this.db.prepare('SELECT json FROM approvals WHERE id = ?').get(id) as { json: string } | undefined;
    if (!row) throw new Error(`Unknown approval ${id}`);
    const a: Approval = JSON.parse(row.json);
    if (a.status !== 'pending') throw new Error(`Approval ${id} is already ${a.status}`);
    return a;
  }

  /** Approval re-runs every check against a fresh quote at the moment of approval. */
  async approve(id: string): Promise<{ approval: Approval; order: OrderRecord }> {
    const a = this.pending(id);
    const order = await this.submit(a.intent, 'confirm', a.ruleName);
    const approval = this.decide(a, 'approved', order.status === 'rejected' ? `Approved, but the guard rejected it: ${order.reason}` : `Order ${order.id} ${order.status}`);
    return { approval, order };
  }

  reject(id: string): Approval {
    return this.decide(this.pending(id), 'rejected', 'Rejected by user');
  }

  // ── Portfolio ──────────────────────────────────────────────────────────────
  async portfolio(): Promise<{ connectionId: string; name: string; mode: 'paper' | 'live'; armed: boolean; account: Account | null; positions: Position[]; error: string | null }[]> {
    const out = [];
    for (const c of this.reg.list('broker').filter((x) => x.enabled)) {
      const b = this.broker(c.id);
      const ctx = this.reg.ctx(c.id);
      try {
        const [account, positions] = await Promise.all([b.account(ctx), b.positions(ctx)]);
        if (c.pluginId === 'paper') {
          let mv = 0;
          for (const p of positions) {
            try {
              const q = await this.market.quote(p.instrument);
              const mult = this.market.instrument(p.instrument).multiplier;
              p.marketPrice = q.price;
              p.unrealizedPnl = (q.price - p.avgPrice) * p.qty * mult;
              mv += q.price * p.qty * mult;
            } catch { /* leave unpriced */ }
          }
          account.equity = (account.cash ?? 0) + mv;
        }
        out.push({ connectionId: c.id, name: c.name, mode: this.mode(c.id), armed: this.liveArmed(c.id), account, positions, error: null });
      } catch (e) {
        out.push({ connectionId: c.id, name: c.name, mode: this.mode(c.id), armed: false, account: null, positions: [], error: short(e) });
      }
    }
    return out;
  }
}
