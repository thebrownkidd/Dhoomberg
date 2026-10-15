import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PyBridge } from '../server/pybridge';

const dir = mkdtempSync(join(tmpdir(), 'dhoomberg-py-'));
cpSync(resolve(__dirname, '../plugins/examples'), join(dir, 'examples'), { recursive: true });
writeFileSync(join(dir, 'slow.py'), `
import time
from dhoomberg_runtime import indicator

@indicator(name="slow")
def slow(series):
    time.sleep(5)
    return series

@indicator(name="crash")
def crash(series):
    import os
    os._exit(3)
`);
writeFileSync(join(dir, 'broken.py'), 'this is not python\n');

const py = new PyBridge(undefined, dir);
const dates = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
const closes = dates.map((_, i) => 100 * Math.exp(0.001 * i + 0.02 * Math.sin(i / 7)));

beforeAll(async () => { await py.start(); }, 60_000);
afterAll(() => py.stop());

describe('python bridge', () => {
  it('discovers example plugins and reports broken files without dying', () => {
    expect(py.error).toBeNull();
    const names = py.plugins.map((p) => p.name).sort();
    expect(names).toEqual(expect.arrayContaining(['breakout', 'garch_vol', 'kalman', 'theta', 'warehouse_csv']));
    expect(Object.keys(py.loadErrors)).toContain('broken.py');
  });
  it('runs an indicator and returns one value per bar', async () => {
    const r = await py.call<Record<string, (number | null)[]>>('kalman', { dates, closes, params: {} });
    expect(r.value).toHaveLength(300);
    expect(Math.abs(r.value[299]! - closes[299]) / closes[299]).toBeLessThan(0.05);
  });
  it('NaNs come back as null, not invalid JSON', async () => {
    const r = await py.call<Record<string, (number | null)[]>>('garch_vol', { dates, closes, params: {} });
    expect(r.value[0]).toBeNull();
    expect(r.value[299]).toBeGreaterThan(0);
  });
  it('runs a model', async () => {
    const f = await py.call<number[]>('theta', { dates, closes, horizon: 5, params: {} });
    expect(f).toHaveLength(5);
  });
  it('runs a data source', async () => {
    const bars = await py.call<{ date: string; close: number }[]>('warehouse_csv', { symbol: 'sugar_landed_inr_kg', start: null, params: {} });
    expect(bars.length).toBeGreaterThan(500);
  });
  it('surfaces plugin exceptions as errors', async () => {
    await expect(py.call('warehouse_csv', { symbol: 'nope', start: null, params: {} })).rejects.toThrow(/No column 'nope'/);
  });
  it('times out a hung plugin and restarts the worker', async () => {
    await expect(py.call('slow', { dates, closes, params: {} }, 1000)).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 2500));
    const r = await py.call<Record<string, unknown[]>>('kalman', { dates, closes, params: {} });
    expect(r.value).toHaveLength(300);
  }, 20_000);
  it('recovers from a worker crash', async () => {
    await expect(py.call('crash', { dates, closes, params: {} })).rejects.toThrow(/exited/);
    await new Promise((r) => setTimeout(r, 2500));
    const f = await py.call<number[]>('theta', { dates, closes, horizon: 3, params: {} });
    expect(f).toHaveLength(3);
  }, 20_000);
});
