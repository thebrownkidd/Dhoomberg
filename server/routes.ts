import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { INDICATORS } from '../shared/indicators';
import type { Group, HealthInfo, Instrument, OrderIntent, Rule, RiskLimits } from '../shared/types';
import { kvGet, kvSet, type DB } from './db';
import { audit, bus, readAudit } from './events';
import type { Market } from './market';
import type { Executor } from './orders/executor';
import { UPLOAD_DIR } from './plugins/datasources';
import type { PyBridge } from './pybridge';
import type { Registry } from './registry';
import type { RuleEngine } from './rules/engine';
import { indicatorSeries, type AnalystService, type ModelService, type NewsService } from './services';

export type App = { db: DB; reg: Registry; market: Market; py: PyBridge; news: NewsService; models: ModelService; analyst: AnalystService; executor: Executor; rules: RuleEngine };

const VERSION = '0.2.0';

export function registerRoutes(f: FastifyInstance, a: App) {
  type P<T = Record<string, string>> = { Params: T };

  // ── Health / catalog ───────────────────────────────────────────────────────
  f.get('/api/health', async (): Promise<HealthInfo> => ({
    ok: true, version: VERSION, halted: a.executor.halted(),
    python: { available: a.py.available, plugins: a.py.plugins.length, error: a.py.error },
    connections: a.reg.list().map((c) => {
      const p = (() => { try { return a.reg.get(c.pluginId); } catch { return null; } })();
      return {
        id: c.id, name: c.name, pluginId: c.pluginId, kind: p?.kind ?? 'datasource', enabled: c.enabled, ok: c.lastTest ? c.lastTest.ok : null,
        live: p?.kind === 'broker' ? a.executor.mode(c.id) === 'live' && a.executor.liveArmed(c.id) : false,
      };
    }),
  }));

  f.get('/api/plugins', async () => ({ plugins: a.reg.manifests(), python: { plugins: a.py.plugins, errors: a.py.loadErrors, error: a.py.error } }));
  f.post('/api/python/reload', async () => { await a.py.refresh(true); return { plugins: a.py.plugins, errors: a.py.loadErrors, error: a.py.error }; });

  f.get('/api/indicators', async () => ({
    builtin: INDICATORS,
    python: a.reg.pythonPlugins('indicator').map((p) => ({ id: `py:${p.name}`, name: p.title, group: p.signal ? 'Signals (Python)' : 'Python', pane: p.pane ?? 'sub', outputs: p.outputs ?? ['value'], levels: p.levels ?? [], description: p.description, params: Object.entries(p.params).map(([k, v]) => ({ key: k, label: k, default: v, min: -1e9, max: 1e9 })) })),
  }));

  // ── Connections ────────────────────────────────────────────────────────────
  f.get<{ Querystring: { kind?: string } }>('/api/connections', async (req) => a.reg.list(req.query.kind as never));
  f.post<{ Body: { pluginId: string; name: string; config: Record<string, unknown> } }>('/api/connections', async (req) => {
    const c = a.reg.create(req.body.pluginId, req.body.name, req.body.config ?? {});
    audit(a.db, 'connection_created', { id: c.id, plugin: c.pluginId, name: c.name });
    return c;
  });
  f.put<P & { Body: { name?: string; config?: Record<string, unknown>; enabled?: boolean } }>('/api/connections/:id', async (req) => {
    const c = a.reg.update(req.params.id, req.body);
    audit(a.db, 'connection_updated', { id: c.id, fields: Object.keys(req.body.config ?? {}), enabled: c.enabled });
    return c;
  });
  f.delete<P>('/api/connections/:id', async (req) => {
    a.reg.remove(req.params.id);
    audit(a.db, 'connection_deleted', { id: req.params.id });
    return { ok: true };
  });
  f.post<P>('/api/connections/:id/test', async (req) => a.reg.test(req.params.id));

  f.post<{ Body: { name: string; contentBase64: string } }>('/api/uploads', async (req) => {
    const ext = extname(req.body.name).toLowerCase();
    if (!['.csv', '.txt'].includes(ext)) throw new Error('Only .csv files are supported. In Excel use File → Save As → CSV.');
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const file = `${Date.now()}_${req.body.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    writeFileSync(join(UPLOAD_DIR, file), Buffer.from(req.body.contentBase64, 'base64'));
    return { file };
  });

  // ── Market data ────────────────────────────────────────────────────────────
  f.get('/api/instruments', async () => a.market.instruments().map((i) => ({ ...i, realtime: a.market.isRealtime(i) })));
  f.post<{ Body: Omit<Instrument, 'custom'> }>('/api/instruments', async (req) => a.market.upsert(req.body));
  f.delete<P>('/api/instruments/:id', async (req) => { a.market.remove(req.params.id); return { ok: true }; });

  f.get<P>('/api/series/:id', async (req) => a.market.seriesWithQuote(req.params.id));
  f.get<{ Querystring: { ids?: string } }>('/api/watchlist', async (req) => {
    const ids = (req.query.ids ?? '').split(',').filter(Boolean);
    return Promise.all(ids.map(async (id) => {
      try {
        const i = a.market.instrument(id);
        const bars = await a.market.seriesWithQuote(id);
        const q = await a.market.quote(id).catch(() => null);
        const year = bars.slice(-260).map((b) => b.close);
        return {
          id: i.id, code: i.code, name: i.name, unit: i.unit, dp: i.dp,
          last: q?.price ?? bars.at(-1)!.close, prevClose: bars.at(-2)?.close ?? bars.at(-1)!.close,
          low52: Math.min(...year), high52: Math.max(...year), ts: q?.ts ?? null, error: null,
        };
      } catch (e) {
        return { id, error: (e as Error).message };
      }
    }));
  });
  f.get<{ Querystring: { ids?: string } }>('/api/quotes', async (req) => {
    const ids = (req.query.ids ?? '').split(',').filter(Boolean);
    const out: Record<string, { price: number; ts: string } | { error: string }> = {};
    await Promise.all(ids.map(async (id) => {
      try { const q = await a.market.quote(id); out[id] = { price: q.price, ts: q.ts }; } catch (e) { out[id] = { error: (e as Error).message }; }
    }));
    return out;
  });

  f.get<{ Querystring: { instrument: string; id: string; params?: string } }>('/api/indicator', async (req) => {
    const params = req.query.params ? JSON.parse(req.query.params) : {};
    return indicatorSeries(a.market, a.py, a.reg, req.query.instrument, req.query.id, params);
  });

  f.get('/api/models', async () => a.models.options());
  f.get<{ Querystring: { instrument: string; model: string; horizon?: string } }>('/api/forecast', async (req) =>
    a.models.run(req.query.model, req.query.instrument, Number(req.query.horizon ?? 10)));

  f.get<{ Querystring: { connectionId?: string; query?: string } }>('/api/news', async (req) => {
    const r = await a.news.items({ connectionId: req.query.connectionId || undefined, query: req.query.query || undefined });
    return { ...r, errors: a.news.errors };
  });
  f.get<{ Querystring: { connectionId: string; instrument: string; fresh?: string } }>('/api/llm-view', async (req) =>
    a.analyst.view(req.query.connectionId, req.query.instrument, req.query.fresh ? 0 : undefined));

  // ── Rules ──────────────────────────────────────────────────────────────────
  f.get('/api/rules', async () => a.rules.list());
  f.post<{ Body: Partial<Rule> }>('/api/rules', async (req) => a.rules.save({ ...req.body, id: undefined }));
  f.put<P & { Body: Partial<Rule> }>('/api/rules/:id', async (req) => {
    const cur = a.rules.get(req.params.id);
    return a.rules.save({ ...cur, ...req.body, id: cur.id, createdAt: cur.createdAt });
  });
  f.delete<P>('/api/rules/:id', async (req) => { a.rules.remove(req.params.id); return { ok: true }; });
  f.post<{ Body: { when: Group } }>('/api/rules/evaluate', async (req) => {
    const r = await a.rules.evaluate({ id: 'draft', name: 'draft', enabled: false, when: req.body.when, cadence: { type: 'tick' }, cooldownMin: 0, mode: 'notify', actions: [], createdAt: '', updatedAt: '' });
    return { result: r.result, details: r.details, bar: r.bar, price: r.price };
  });
  f.post<{ Body: { rule: Partial<Rule>; horizonBars?: number } }>('/api/rules/backtest', async (req) => {
    const rule = { id: 'draft', name: 'draft', enabled: false, cadence: { type: 'tick' as const }, cooldownMin: 0, mode: 'notify' as const, actions: [], createdAt: '', updatedAt: '', ...req.body.rule } as Rule;
    return a.rules.backtest(rule, Math.max(1, Math.min(250, Number(req.body.horizonBars ?? 5))));
  });

  // ── Trading ────────────────────────────────────────────────────────────────
  f.get('/api/approvals', async () => a.executor.approvals());
  f.post<P>('/api/approvals/:id/approve', async (req) => a.executor.approve(req.params.id));
  f.post<P>('/api/approvals/:id/reject', async (req) => a.executor.reject(req.params.id));

  f.get<{ Querystring: { limit?: string } }>('/api/orders', async (req) => a.executor.orders(Number(req.query.limit ?? 200)));
  f.post<{ Body: Omit<OrderIntent, 'idemKey'> }>('/api/orders', async (req) => {
    const b = req.body;
    const inst = a.market.instrument(b.instrument);
    return a.executor.submit({ ...b, instrument: inst.id, symbol: b.symbol || inst.symbol, qty: Number(b.qty), limitPrice: b.limitPrice ? Number(b.limitPrice) : undefined, idemKey: `manual:${randomUUID()}` }, 'manual');
  });
  f.get('/api/portfolio', async () => a.executor.portfolio());

  f.get('/api/risk', async () => a.executor.limits());
  f.put<{ Body: Partial<RiskLimits> }>('/api/risk', async (req) => a.executor.setLimits(req.body));
  f.post<{ Body: { reason?: string } }>('/api/halt', async (req) => { await a.executor.halt(req.body?.reason || 'Manual HALT'); return { halted: true }; });
  f.post('/api/resume', async () => { a.executor.resume(); return { halted: false }; });
  f.post<P & { Body: { accountId: string } }>('/api/brokers/:id/arm', async (req) => { a.executor.arm(req.params.id, String(req.body.accountId ?? '')); return { armed: true }; });
  f.post<P>('/api/brokers/:id/disarm', async (req) => { a.executor.disarm(req.params.id); return { armed: false }; });

  // ── Audit ──────────────────────────────────────────────────────────────────
  f.get<{ Querystring: { limit?: string; before?: string; kind?: string } }>('/api/audit', async (req) =>
    readAudit(a.db, { limit: Number(req.query.limit ?? 200), before: req.query.before ? Number(req.query.before) : undefined, kind: req.query.kind || undefined }));
  f.get('/api/audit/export', async (_req, reply) => {
    const rows = readAudit(a.db, { limit: 5000 });
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const csv = ['id,ts,kind,rule_id,ref,detail', ...rows.map((r) => [r.id, r.ts, r.kind, r.ruleId ?? '', r.ref ?? '', esc(JSON.stringify(r.detail))].join(','))].join('\n');
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', 'attachment; filename="dhoomberg_audit.csv"');
    return csv;
  });

  // ── Workspace + config import/export (secrets never included) ──────────────
  f.get('/api/workspace', async () => kvGet(a.db, 'workspace', {}));
  f.put<{ Body: Record<string, unknown> }>('/api/workspace', async (req) => { kvSet(a.db, 'workspace', req.body); return req.body; });

  f.get('/api/config/export', async () => ({
    format: 'dhoomberg-config', version: 1, exportedAt: new Date().toISOString(),
    note: 'Secrets (API keys, passwords) are not included. Re-enter them after import.',
    connections: a.reg.list().map(({ id, pluginId, name, config, enabled }) => ({ id, pluginId, name, config, enabled, secretFields: Object.keys(a.reg.connection(id).secrets) })),
    instruments: a.market.instruments().filter((i) => i.connectionId !== 'demo' || i.custom),
    rules: a.rules.list().map(({ state: _s, ...r }) => r),
    risk: a.executor.limits(),
    workspace: kvGet(a.db, 'workspace', {}),
  }));
  f.post<{ Body: { format: string; connections?: { id: string; pluginId: string; name: string; config: Record<string, unknown>; enabled: boolean }[]; instruments?: Instrument[]; rules?: Rule[]; risk?: RiskLimits; workspace?: Record<string, unknown> } }>('/api/config/import', async (req) => {
    const b = req.body;
    if (b.format !== 'dhoomberg-config') throw new Error('Not a Dhoomberg config file');
    const idMap = new Map<string, string>([['demo', 'demo']]);
    const report = { connections: 0, instruments: 0, rules: 0, skipped: [] as string[] };
    for (const c of b.connections ?? []) {
      try { const n = a.reg.create(c.pluginId, c.name, c.config); idMap.set(c.id, n.id); report.connections++; } catch (e) { report.skipped.push(`connection ${c.name}: ${(e as Error).message}`); }
    }
    for (const i of b.instruments ?? []) {
      const conn = idMap.get(i.connectionId);
      if (!conn) { report.skipped.push(`instrument ${i.id}: its connection was not imported`); continue; }
      try { a.market.upsert({ ...i, connectionId: conn }); report.instruments++; } catch (e) { report.skipped.push(`instrument ${i.id}: ${(e as Error).message}`); }
    }
    const remap = (s: string) => JSON.parse(s.replace(/"connectionId":"([^"]+)"/g, (m, id) => (idMap.has(id) ? `"connectionId":"${idMap.get(id)}"` : m)));
    for (const r of b.rules ?? []) {
      try { a.rules.save({ ...remap(JSON.stringify(r)), id: undefined, enabled: false }); report.rules++; } catch (e) { report.skipped.push(`rule ${r.name}: ${(e as Error).message}`); }
    }
    if (b.risk) a.executor.setLimits(b.risk);
    if (b.workspace) kvSet(a.db, 'workspace', b.workspace);
    audit(a.db, 'config_imported', report);
    return { ...report, note: 'Imported rules are disabled. Re-enter secrets, test each connection, then enable rules.' };
  });

  // ── Live events (SSE) ──────────────────────────────────────────────────────
  f.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('retry: 3000\n\n');
    const send = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    bus.on('event', send);
    req.raw.on('close', () => { clearInterval(ping); bus.off('event', send); });
  });
}
