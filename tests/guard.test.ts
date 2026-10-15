import { describe, expect, it } from 'vitest';
import { checkOrder, isMarketOpen, type GuardInput } from '../server/orders/guard';
import { DEFAULT_RISK_LIMITS } from '../shared/types';

const now = new Date('2026-10-13T15:00:00Z');

function base(over: Partial<GuardInput> = {}, intent: Partial<GuardInput['intent']> = {}): GuardInput {
  return {
    intent: { connectionId: 'paper_1', instrument: 'WTI', symbol: 'WTI', side: 'buy', qty: 10, orderType: 'market', tif: 'day', idemKey: 'r:0:x', ...intent },
    refPrice: 70, quoteTs: new Date(now.getTime() - 10_000).toISOString(), now,
    limits: DEFAULT_RISK_LIMITS, halted: false, mode: 'paper', liveArmed: false, sourceRealtime: false, sourceName: 'Demo',
    execMode: 'manual', autoAllowed: false, multiplier: 1, todayNotional: 0, todayCount: 0, positionQty: 0, duplicate: false, marketOpen: true,
    ...over,
  };
}

const rejects = (g: GuardInput, pattern: RegExp) => {
  const r = checkOrder(g);
  expect(r.ok).toBe(false);
  expect(r.reasons.join(' | ')).toMatch(pattern);
};

describe('order guard', () => {
  it('passes a small fresh paper order', () => {
    const r = checkOrder(base());
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notional).toBe(700);
  });

  it('rejects when halted', () => rejects(base({ halted: true }), /halted/));
  it('rejects non-positive quantity', () => rejects(base({}, { qty: 0 }), /Quantity/));
  it('rejects without a valid price', () => rejects(base({ refPrice: NaN }), /reference price/));
  it('rejects a stale quote', () => rejects(base({ quoteTs: new Date(now.getTime() - 301_000).toISOString() }), /Quote is 301s old/));
  it('rejects a quote of unknown age', () => rejects(base({ quoteTs: 'garbage' }), /unknown age/));
  it('rejects live orders when not armed', () => rejects(base({ mode: 'live', sourceRealtime: true }), /not armed/));
  it('rejects live orders driven by a demo/delayed source', () => rejects(base({ mode: 'live', liveArmed: true }), /real-time data source/));
  it('allows a live order that is armed and real-time', () => expect(checkOrder(base({ mode: 'live', liveArmed: true, sourceRealtime: true })).ok).toBe(true));
  it('rejects auto mode when the broker disallows it', () => rejects(base({ execMode: 'auto' }), /Auto execution is disabled/));
  it('rejects over per-order notional', () => rejects(base({}, { qty: 200 }), /per-order limit/));
  it('counts the contract multiplier in notional', () => rejects(base({ multiplier: 1000 }, { qty: 1 }), /per-order limit/));
  it('rejects over daily notional', () => rejects(base({ todayNotional: 49_500 }), /Daily notional/));
  it('rejects over daily order count', () => rejects(base({ todayCount: 20 }), /order count/));
  it('rejects growing a position past the cap', () => rejects(base({ positionQty: 350 }), /per-instrument cap/));
  it('allows reducing a position that is over the cap', () => expect(checkOrder(base({ positionQty: 400 }, { side: 'sell' })).ok).toBe(true));
  it('rejects a limit far from the market', () => rejects(base({}, { orderType: 'limit', limitPrice: 75 }), /from the last price/));
  it('rejects a limit order with no price', () => rejects(base({}, { orderType: 'limit' }), /positive limit price/));
  it('allows a limit inside the band', () => expect(checkOrder(base({}, { orderType: 'limit', limitPrice: 69.5 })).ok).toBe(true));
  it('rejects duplicates', () => rejects(base({ duplicate: true }), /Duplicate/));
  it('rejects when the market is closed', () => rejects(base({ marketOpen: false }), /closed/));
  it('reports every failing reason at once', () => {
    const r = checkOrder(base({ halted: true, duplicate: true, marketOpen: false }));
    expect(r.reasons.length).toBe(3);
  });
});

describe('trading hours', () => {
  const at = (iso: string) => new Date(iso);
  it('24/7 and empty are always open', () => {
    expect(isMarketOpen('24/7', at('2026-10-11T03:00:00Z'))).toBe(true);
    expect(isMarketOpen('', at('2026-10-11T03:00:00Z'))).toBe(true);
  });
  it('US equities session in New York time', () => {
    const spec = 'Mon-Fri 09:30-16:00 America/New_York';
    expect(isMarketOpen(spec, at('2026-10-13T14:00:00Z'))).toBe(true);    // Tue 10:00 EDT
    expect(isMarketOpen(spec, at('2026-10-13T13:00:00Z'))).toBe(false);   // Tue 09:00 EDT
    expect(isMarketOpen(spec, at('2026-10-17T15:00:00Z'))).toBe(false);   // Saturday
  });
  it('futures session crossing midnight', () => {
    const spec = 'Sun-Thu 18:00-17:00 America/New_York';
    expect(isMarketOpen(spec, at('2026-10-11T23:00:00Z'))).toBe(true);    // Sun 19:00 EDT, just opened
    expect(isMarketOpen(spec, at('2026-10-11T21:00:00Z'))).toBe(false);   // Sun 17:00 EDT, before open
    expect(isMarketOpen(spec, at('2026-10-16T20:00:00Z'))).toBe(true);    // Fri 16:00 EDT, Thu session
    expect(isMarketOpen(spec, at('2026-10-16T21:30:00Z'))).toBe(false);   // Fri 17:30 EDT, closed for weekend
    expect(isMarketOpen(spec, at('2026-10-13T21:30:00Z'))).toBe(false);   // Tue 17:30 EDT, daily break
  });
  it('rejects unparseable specs loudly', () => expect(() => isMarketOpen('weekdays 9-5', now)).toThrow(/Cannot parse/));
});
