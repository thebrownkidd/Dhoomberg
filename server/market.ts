import type { Bar, Instrument, Quote } from '../shared/types';
import * as mock from '../src/data/mock';
import type { DB } from './db';
import { emit } from './events';
import type { DataSourceImpl } from './plugins/types';
import type { Registry } from './registry';

type Row = { id: string; name: string; code: string; unit: string; dp: number; multiplier: number; connection_id: string; symbol: string };

const BUILTIN: Instrument[] = mock.COMMODITIES.map((c) => ({ id: c.id, name: c.name, code: c.code, unit: c.unit, dp: c.dp, multiplier: 1, connectionId: 'demo', symbol: c.id, custom: false }));
const BUILTIN_IDS = new Set(BUILTIN.map((i) => i.id));

export class Market {
  private seriesCache = new Map<string, { at: number; bars: Promise<Bar[]> }>();
  private quoteCache = new Map<string, { at: number; q: Promise<Quote> }>();

  constructor(private db: DB, private reg: Registry) {}

  instruments(): Instrument[] {
    const rows = this.db.prepare('SELECT * FROM instruments').all() as Row[];
    const byId = new Map(BUILTIN.map((i) => [i.id, i]));
    for (const r of rows) byId.set(r.id, { id: r.id, name: r.name, code: r.code, unit: r.unit, dp: r.dp, multiplier: r.multiplier, connectionId: r.connection_id, symbol: r.symbol, custom: !BUILTIN_IDS.has(r.id) });
    return [...byId.values()];
  }

  instrument(id: string): Instrument {
    const i = this.instruments().find((x) => x.id === id.toUpperCase());
    if (!i) throw new Error(`Unknown instrument: ${id}`);
    return i;
  }

  upsert(i: Omit<Instrument, 'custom'>): Instrument {
    const id = i.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!id) throw new Error('Instrument ID is required');
    if (i.connectionId !== 'demo') this.reg.connection(i.connectionId);
    this.db.prepare(`INSERT INTO instruments (id, name, code, unit, dp, multiplier, connection_id, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, code = excluded.code, unit = excluded.unit, dp = excluded.dp, multiplier = excluded.multiplier, connection_id = excluded.connection_id, symbol = excluded.symbol`)
      .run(id, i.name || id, i.code || id.slice(0, 6), i.unit || '', Math.max(0, Math.min(8, Number(i.dp ?? 2))), Number(i.multiplier) > 0 ? Number(i.multiplier) : 1, i.connectionId, i.symbol || id);
    this.invalidate(id);
    emit({ type: 'connections' });
    return this.instrument(id);
  }

  /** Custom instruments are deleted; built-ins revert to the demo source. */
  remove(id: string) {
    this.db.prepare('DELETE FROM instruments WHERE id = ?').run(id.toUpperCase());
    this.invalidate(id.toUpperCase());
    emit({ type: 'connections' });
  }

  private invalidate(id: string) {
    this.seriesCache.delete(id);
    this.quoteCache.delete(id);
  }

  private source(i: Instrument): DataSourceImpl {
    const p = this.reg.plugin(i.connectionId);
    if (p.kind !== 'datasource') throw new Error(`${i.connectionId} is not a data source`);
    return p.impl;
  }

  isRealtime(i: Instrument): boolean {
    if (i.connectionId === 'demo') return false;
    return !!this.reg.plugin(i.connectionId).capabilities?.realtime;
  }

  async series(id: string, ttlMs = 10 * 60_000): Promise<Bar[]> {
    const i = this.instrument(id);
    if (i.connectionId === 'demo') return this.source(i).fetchSeries(this.reg.ctx('demo'), i.symbol, {});
    const hit = this.seriesCache.get(i.id);
    if (hit && Date.now() - hit.at < ttlMs) return hit.bars;
    const bars = this.source(i).fetchSeries(this.reg.ctx(i.connectionId), i.symbol, {});
    this.seriesCache.set(i.id, { at: Date.now(), bars });
    bars.catch(() => this.seriesCache.delete(i.id));
    return bars;
  }

  async quote(id: string, ttlMs = 5_000): Promise<Quote> {
    const i = this.instrument(id);
    const hit = this.quoteCache.get(i.id);
    if (hit && Date.now() - hit.at < ttlMs) return hit.q;
    const src = this.source(i);
    const ctx = this.reg.ctx(i.connectionId);
    const q = src.quote
      ? src.quote(ctx, i.symbol)
      : this.series(i.id).then((bars) => {
          const last = bars[bars.length - 1];
          return { price: last.close, ts: `${last.date.length === 7 ? `${last.date}-01` : last.date}T00:00:00Z`, source: 'last-bar' };
        });
    this.quoteCache.set(i.id, { at: Date.now(), q });
    q.catch(() => this.quoteCache.delete(i.id));
    return q;
  }

  /** History with the latest quote spliced onto the last bar (or appended if newer). */
  async seriesWithQuote(id: string): Promise<Bar[]> {
    const [bars, q] = await Promise.all([this.series(id), this.quote(id).catch(() => null)]);
    if (!q || !bars.length) return bars;
    const out = bars.slice();
    const qDate = q.ts.slice(0, out[out.length - 1].date.length);
    if (qDate > out[out.length - 1].date) out.push({ date: qDate, close: q.price });
    else out[out.length - 1] = { ...out[out.length - 1], close: q.price };
    return out;
  }
}
