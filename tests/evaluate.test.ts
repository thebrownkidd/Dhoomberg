import { describe, expect, it } from 'vitest';
import { evalCondition, evalGroup, type Resolved } from '../server/rules/evaluate';
import type { Condition, Group } from '../shared/types';

const ser = (xs: (number | null)[]): Resolved => ({ series: xs, scalar: null, historical: true, label: 'L' });
const k = (v: number): Resolved => ({ series: null, scalar: v, historical: true, label: String(v) });
const live = (v: number | null): Resolved => ({ series: null, scalar: v, historical: false, label: 'news' });
const cond = (op: Condition['op'], extra: Partial<Condition> = {}): Condition => ({ kind: 'cond', left: { type: 'const', value: 0 }, op, right: { type: 'const', value: 0 }, ...extra });

describe('condition operators', () => {
  it('comparisons', () => {
    expect(evalCondition(cond('>'), ser([1, 5]), k(3), 1).result).toBe(true);
    expect(evalCondition(cond('<'), ser([1, 5]), k(3), 1).result).toBe(false);
    expect(evalCondition(cond('>='), ser([3]), k(3), 0).result).toBe(true);
    expect(evalCondition(cond('<='), ser([3]), k(3), 0).result).toBe(true);
  });
  it('missing data is null, never true', () => {
    expect(evalCondition(cond('>'), ser([null]), k(3), 0).result).toBeNull();
    expect(evalCondition(cond('>'), ser([5]), live(null), 0).result).toBeNull();
  });
  it('crosses above: only on the bar it crosses', () => {
    const L = ser([1, 2, 4, 5]);
    expect(evalCondition(cond('crosses_above'), L, k(3), 1).result).toBe(false);
    expect(evalCondition(cond('crosses_above'), L, k(3), 2).result).toBe(true);
    expect(evalCondition(cond('crosses_above'), L, k(3), 3).result).toBe(false);
  });
  it('touching the level then moving above counts as a cross', () => {
    expect(evalCondition(cond('crosses_above'), ser([3, 4]), k(3), 1).result).toBe(true);
  });
  it('crosses below with two series', () => {
    expect(evalCondition(cond('crosses_below'), ser([5, 2]), ser([4, 4]), 1).result).toBe(true);
    expect(evalCondition(cond('crosses_below'), ser([5, 4.5]), ser([4, 4]), 1).result).toBe(false);
  });
  it('crosses on the first bar has no history and is null', () => {
    expect(evalCondition(cond('crosses_above'), ser([5]), k(3), 0).result).toBeNull();
  });
  it('crosses on a non-historical operand uses the previous live evaluation', () => {
    const c = cond('crosses_above');
    expect(evalCondition(c, live(0.3), k(0.2), 0, { left: 0.1, right: 0.2 }).result).toBe(true);
    expect(evalCondition(c, live(0.3), k(0.2), 0, { left: 0.25, right: 0.2 }).result).toBe(false);
    expect(evalCondition(c, live(0.3), k(0.2), 0).result).toBeNull();
  });
  it('% change over N bars', () => {
    const r = evalCondition(cond('pct_change_gt', { lookback: 2 }), ser([100, 101, 106]), k(5), 2);
    expect(r.result).toBe(true);
    expect(r.left).toBeCloseTo(6, 10);
    expect(evalCondition(cond('pct_change_lt', { lookback: 2 }), ser([100, 101, 106]), k(5), 2).result).toBe(false);
    expect(evalCondition(cond('pct_change_gt', { lookback: 5 }), ser([100, 101, 106]), k(5), 2).result).toBeNull();
  });
  it('between is inclusive', () => {
    expect(evalCondition(cond('between', { upper: 70 }), ser([30]), k(30), 0).result).toBe(true);
    expect(evalCondition(cond('between', { upper: 70 }), ser([71]), k(30), 0).result).toBe(false);
  });
});

describe('groups', () => {
  const T = cond('>'), F = cond('<');
  const leaf = (c: Condition) => ({ result: c === T, left: 1, right: 0, label: '' });
  it('all / any / nested', () => {
    const g: Group = { kind: 'group', mode: 'all', items: [T, { kind: 'group', mode: 'any', items: [F, T] }] };
    expect(evalGroup(g, leaf).result).toBe(true);
    expect(evalGroup({ ...g, items: [T, F] }, leaf).result).toBe(false);
    expect(evalGroup({ kind: 'group', mode: 'any', items: [F, F] }, leaf).result).toBe(false);
  });
  it('an empty group never fires', () => {
    expect(evalGroup({ kind: 'group', mode: 'all', items: [] }, leaf).result).toBe(false);
  });
});
