import { randomUUID } from 'node:crypto';
import type { Connection, JSONSchema, PluginManifest } from '../shared/types';
import type { DB } from './db';
import { emit } from './events';
import { short } from './http';
import { ACTION_PLUGINS } from './plugins/actions';
import { BROKER_PLUGINS } from './plugins/brokers';
import { DATASOURCE_PLUGINS } from './plugins/datasources';
import { MODEL_PLUGINS } from './plugins/models';
import { NEWS_PLUGINS } from './plugins/news';
import { secretFields, type Ctx, type PluginDef } from './plugins/types';
import type { PyBridge, PyManifest } from './pybridge';
import type { Vault } from './vault';

const BUILTIN: PluginDef[] = [...DATASOURCE_PLUGINS, ...NEWS_PLUGINS, ...MODEL_PLUGINS, ...ACTION_PLUGINS, ...BROKER_PLUGINS];

type Row = { id: string; plugin_id: string; name: string; config: string; enabled: number; created_at: string; last_test: string | null };

const memo = new Map<string, { at: number; value: Promise<unknown> }>();

function paramsSchema(params: Record<string, unknown>): JSONSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string', title: k, default: v } as JSONSchema])),
  };
}

export class Registry {
  constructor(private db: DB, private vault: Vault, private py: PyBridge | null) {}

  private pythonDefs(): PluginDef[] {
    if (!this.py) return [];
    return this.py.plugins.filter((p) => p.kind === 'datasource').map((p) => ({
      id: `py:${p.name}`, kind: 'datasource' as const, name: p.title, category: 'Python plugins', source: 'python' as const,
      description: `${p.description || 'Python data source'} (${p.file})`,
      configSchema: { ...paramsSchema(p.params), properties: { ...paramsSchema(p.params).properties, testSymbol: { type: 'string', title: 'Symbol used by "Test connection"' } } },
      capabilities: { realtime: false },
      impl: {
        fetchSeries: (ctx, symbol, opts) => this.py!.call(p.name, { symbol, start: opts.from ?? null, params: stripMeta(ctx.config) }, 120_000),
        test: async (ctx) => {
          const bars = await this.py!.call<{ date: string; close: number }[]>(p.name, { symbol: ctx.config.testSymbol ?? '', start: null, params: stripMeta(ctx.config) }, 120_000);
          return `${bars.length} bars, last ${bars.at(-1)?.date} = ${bars.at(-1)?.close}`;
        },
      },
    }));
  }

  pythonPlugins(kind: PyManifest['kind']): PyManifest[] {
    return this.py?.plugins.filter((p) => p.kind === kind) ?? [];
  }

  all(): PluginDef[] {
    return [...BUILTIN, ...this.pythonDefs()];
  }

  manifests(): PluginManifest[] {
    return this.all().map(({ impl: _impl, ...m }) => m);
  }

  get(id: string): PluginDef {
    const p = this.all().find((x) => x.id === id);
    if (!p) throw new Error(`Unknown plugin: ${id}`);
    return p;
  }

  // ── Connections ────────────────────────────────────────────────────────────
  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`Unknown connection: ${id}`);
    return r;
  }

  private toConnection(r: Row): Connection {
    return {
      id: r.id, pluginId: r.plugin_id, name: r.name, config: JSON.parse(r.config), secrets: this.vault.hints(r.id),
      enabled: !!r.enabled, createdAt: r.created_at, lastTest: r.last_test ? JSON.parse(r.last_test) : null,
    };
  }

  list(kind?: PluginDef['kind']): Connection[] {
    const rows = this.db.prepare('SELECT * FROM connections ORDER BY created_at').all() as Row[];
    return rows.map((r) => this.toConnection(r)).filter((c) => {
      if (!kind) return true;
      try { return this.get(c.pluginId).kind === kind; } catch { return false; }
    });
  }

  connection(id: string): Connection {
    return this.toConnection(this.row(id));
  }

  plugin(connectionId: string): PluginDef {
    if (connectionId === 'demo') return this.get('demo');
    return this.get(this.row(connectionId).plugin_id);
  }

  ctx(connectionId: string): Ctx {
    const config = connectionId === 'demo' ? {} : { ...JSON.parse(this.row(connectionId).config), ...this.vault.all(connectionId) };
    return {
      connectionId,
      config,
      db: this.db,
      cache: <T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
        const k = `${connectionId}|${key}`;
        const hit = memo.get(k);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
        const value = fn().catch((e) => { memo.delete(k); throw e; });
        memo.set(k, { at: Date.now(), value });
        return value;
      },
    };
  }

  private split(plugin: PluginDef, config: Record<string, unknown>) {
    const secrets = secretFields(plugin.configSchema);
    const props = plugin.configSchema.properties ?? {};
    const plain: Record<string, unknown> = {};
    const secret: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(config)) {
      if (!(k in props)) continue;
      if (secrets.includes(k)) {
        if (v === null) secret[k] = null;
        else if (typeof v === 'string' && v !== '' && !v.startsWith('●●●●')) secret[k] = v;
        continue;
      }
      const t = props[k].type;
      plain[k] = v === '' || v === null || v === undefined ? undefined : t === 'number' || t === 'integer' ? Number(v) : t === 'boolean' ? !!v : v;
    }
    return { plain: JSON.parse(JSON.stringify(plain)), secret };
  }

  create(pluginId: string, name: string, config: Record<string, unknown>): Connection {
    const plugin = this.get(pluginId);
    const id = `${pluginId.replace(/[^a-z0-9]/gi, '').slice(0, 12)}_${randomUUID().slice(0, 8)}`;
    const { plain, secret } = this.split(plugin, config);
    this.db.prepare('INSERT INTO connections (id, plugin_id, name, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(id, pluginId, name || plugin.name, JSON.stringify(plain), new Date().toISOString());
    for (const [k, v] of Object.entries(secret)) if (v) this.vault.set(id, k, v);
    memo.clear();
    emit({ type: 'connections' });
    return this.connection(id);
  }

  update(id: string, patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean }): Connection {
    const r = this.row(id);
    const plugin = this.get(r.plugin_id);
    if (patch.config) {
      const { plain, secret } = this.split(plugin, patch.config);
      this.db.prepare('UPDATE connections SET config = ? WHERE id = ?').run(JSON.stringify(plain), id);
      for (const [k, v] of Object.entries(secret)) {
        if (v === null) this.vault.remove(id, k);
        else this.vault.set(id, k, v);
      }
    }
    if (patch.name !== undefined) this.db.prepare('UPDATE connections SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.enabled !== undefined) this.db.prepare('UPDATE connections SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    memo.clear();
    emit({ type: 'connections' });
    return this.connection(id);
  }

  remove(id: string) {
    this.row(id);
    this.vault.remove(id);
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    memo.clear();
    emit({ type: 'connections' });
  }

  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const plugin = this.plugin(id);
    let res: { ok: boolean; message: string };
    try {
      res = { ok: true, message: await plugin.impl.test(this.ctx(id)) };
    } catch (e) {
      res = { ok: false, message: short(e) };
    }
    if (id !== 'demo') this.db.prepare('UPDATE connections SET last_test = ? WHERE id = ?').run(JSON.stringify({ ...res, at: new Date().toISOString() }), id);
    emit({ type: 'connections' });
    return res;
  }
}

function stripMeta(c: Record<string, any>) {
  const { testSymbol: _t, ...rest } = c;
  return rest;
}
