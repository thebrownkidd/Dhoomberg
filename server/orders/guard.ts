// Pre-trade risk checks. Pure: every input is passed in, so each rule is unit-testable.
// All failing reasons are reported, not just the first.
import type { OrderIntent, RiskLimits } from '../../shared/types';

export type GuardInput = {
  intent: OrderIntent;
  refPrice: number;
  quoteTs: string;
  now: Date;
  limits: RiskLimits;
  halted: boolean;
  mode: 'paper' | 'live';
  liveArmed: boolean;
  sourceRealtime: boolean;
  sourceName: string;
  execMode: 'manual' | 'confirm' | 'auto';
  autoAllowed: boolean;
  multiplier: number;
  todayNotional: number;
  todayCount: number;
  positionQty: number;
  duplicate: boolean;
  marketOpen: boolean;
};

export type GuardResult = { ok: boolean; reasons: string[]; notional: number };

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function checkOrder(g: GuardInput): GuardResult {
  const r: string[] = [];
  const { intent: o, limits: L } = g;

  if (g.halted) r.push('Trading is halted (kill switch). RESUME to re-enable.');
  if (!(o.qty > 0) || !Number.isFinite(o.qty)) r.push(`Quantity must be a positive number (got ${o.qty}).`);
  if (!(g.refPrice > 0) || !Number.isFinite(g.refPrice)) r.push('No valid reference price for this instrument.');

  const age = (g.now.getTime() - Date.parse(g.quoteTs)) / 1000;
  if (!Number.isFinite(age) || age > L.maxQuoteAgeSec) {
    r.push(`Quote is ${Number.isFinite(age) ? `${Math.round(age)}s` : 'of unknown age'} old (limit ${L.maxQuoteAgeSec}s). Orders need a fresh price; monthly/daily sources can only notify.`);
  }

  if (g.mode === 'live') {
    if (!g.liveArmed) r.push('Live trading is not armed for this broker. Arm it in Settings → Brokers & Risk.');
    if (!g.sourceRealtime) r.push(`Live orders need a real-time data source; ${g.sourceName} is demo or delayed.`);
  }
  if (g.execMode === 'auto' && !g.autoAllowed) r.push('Auto execution is disabled for this broker; use confirm mode or enable auto in the broker settings.');

  const notional = Number.isFinite(o.qty * g.refPrice * g.multiplier) ? Math.abs(o.qty * g.refPrice * g.multiplier) : 0;
  if (notional > L.maxOrderNotional) r.push(`Order notional ${usd(notional)} exceeds the per-order limit of ${usd(L.maxOrderNotional)}.`);
  if (g.todayNotional + notional > L.maxDailyNotional) r.push(`Daily notional would reach ${usd(g.todayNotional + notional)}, over the ${usd(L.maxDailyNotional)} limit.`);
  if (g.todayCount + 1 > L.maxOrdersPerDay) r.push(`Daily order count limit of ${L.maxOrdersPerDay} reached.`);

  const nextQty = g.positionQty + (o.side === 'buy' ? o.qty : -o.qty);
  const nextExposure = Math.abs(nextQty * g.refPrice * g.multiplier);
  if (Math.abs(nextQty) > Math.abs(g.positionQty) && nextExposure > L.maxPositionNotional) {
    r.push(`Position would grow to ${usd(nextExposure)}, over the per-instrument cap of ${usd(L.maxPositionNotional)}.`);
  }

  if (o.orderType === 'limit') {
    if (!(o.limitPrice! > 0)) r.push('Limit orders need a positive limit price.');
    else if (g.refPrice > 0) {
      const dev = Math.abs(o.limitPrice! / g.refPrice - 1) * 100;
      if (dev > L.maxLimitDeviationPct) r.push(`Limit ${o.limitPrice} is ${dev.toFixed(2)}% from the last price ${g.refPrice} (max ${L.maxLimitDeviationPct}%).`);
    }
  }

  if (g.duplicate) r.push(`Duplicate order: ${o.idemKey} was already submitted.`);
  if (!g.marketOpen) r.push("Market is closed per this broker's trading hours.");

  return { ok: r.length === 0, reasons: r, notional };
}

// ── Trading hours: "24/7" | "Mon-Fri 09:30-16:00 America/New_York" | "Sun-Thu 18:00-17:00 America/New_York" ──
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDays(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map((x) => DAYS.indexOf(x.trim().slice(0, 3)));
    if (a < 0) throw new Error(`Bad day "${part}"`);
    if (b === undefined || b < 0) { out.add(a); continue; }
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return out;
}

export function isMarketOpen(spec: string | undefined, now: Date): boolean {
  const s = (spec ?? '').trim();
  if (!s || s === '24/7') return true;
  const m = /^([A-Za-z,-]+)\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s+(\S+)$/.exec(s);
  if (!m) throw new Error(`Cannot parse trading hours "${s}". Use e.g. "Mon-Fri 09:30-16:00 America/New_York" or "24/7".`);
  const days = parseDays(m[1]);
  const start = +m[2] * 60 + +m[3], end = +m[4] * 60 + +m[5];
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: m[6], weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const day = DAYS.indexOf(parts.find((p) => p.type === 'weekday')!.value);
  const mins = +parts.find((p) => p.type === 'hour')!.value * 60 + +parts.find((p) => p.type === 'minute')!.value;
  if (end > start) return days.has(day) && mins >= start && mins < end;
  // Session crosses midnight: opens on a listed day, closes the next day.
  return (days.has(day) && mins >= start) || (days.has((day + 6) % 7) && mins < end);
}
