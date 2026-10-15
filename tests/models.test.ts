import { describe, expect, it } from 'vitest';
import { evaluateForecaster, nextDates, runBuiltinModel } from '../shared/models';
import type { Bar } from '../shared/types';

function bars(fn: (i: number) => number, n = 400): Bar[] {
  const d = new Date('2024-01-01T00:00:00Z');
  const out: Bar[] = [];
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push({ date: d.toISOString().slice(0, 10), close: fn(out.length) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe('forecast evaluation', () => {
  it('naive scores zero skill against itself', async () => {
    let s = 1;
    const r = await runBuiltinModel('naive', bars(() => 100 * Math.exp((s = (s * 16807) % 2147483647) / 2147483647 * 0.1)), 5);
    expect(r.evaluation!.skill).toBeCloseTo(0, 10);
  });
  it('trend models beat naive on a clean trend', async () => {
    const b = bars((i) => 100 * Math.exp(0.002 * i));
    for (const m of ['drift', 'lintrend', 'holt']) {
      const r = await runBuiltinModel(m, b, 10);
      expect(r.evaluation!.skill, m).toBeGreaterThan(0.5);
    }
  });
  it('seasonal naive beats naive on a pure weekly cycle', async () => {
    // Horizon 3, not 5: at a full period naive would also be exact and skill is undefined.
    const r = await runBuiltinModel('snaive', bars((i) => 100 + 5 * Math.sin((2 * Math.PI * i) / 5)), 3);
    expect(r.evaluation!.skill).toBeGreaterThan(0.9);
  });
  it('produces bands that contain the point forecast', async () => {
    let s = 7;
    const rnd = () => (s = (s * 48271) % 2147483647) / 2147483647 - 0.5;
    let x = 100;
    const r = await runBuiltinModel('holt', bars(() => (x *= Math.exp(rnd() * 0.02))), 5);
    expect(r.evaluation!.origins).toBeGreaterThanOrEqual(10);
    for (const p of r.forecast) {
      expect(p.p10).not.toBeNull();
      expect(p.p10!).toBeLessThanOrEqual(p.p50);
      expect(p.p90!).toBeGreaterThanOrEqual(p.p50);
    }
    expect(r.baseline.every((p) => p.p50 === r.baseline[0].p50)).toBe(true);
  });
  it('rejects a model that returns garbage instead of plotting it', async () => {
    await expect(evaluateForecaster('bad', bars(() => 100), 3, () => [1, NaN, 2])).rejects.toThrow(/invalid forecast/);
  });
  it('external forecasters receive raw prices, not logs', async () => {
    const seen: number[] = [];
    await evaluateForecaster('spy', bars((i) => 50 + i), 2, (c, h) => { seen.push(c[c.length - 1]); return new Array(h).fill(c[c.length - 1]); }, { origins: 3 });
    expect(Math.min(...seen)).toBeGreaterThan(40);
  });
});

describe('forecast dates', () => {
  it('daily skips weekends', () => expect(nextDates(['2026-10-08', '2026-10-09'], 2)).toEqual(['2026-10-12', '2026-10-13']));
  it('monthly keeps YYYY-MM', () => expect(nextDates(['2026-08', '2026-09', '2026-10'], 3)).toEqual(['2026-11', '2026-12', '2027-01']));
});
