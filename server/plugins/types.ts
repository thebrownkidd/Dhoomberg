import type { Account, Bar, JSONSchema, NewsItem, OrderIntent, PluginManifest, Position, Quote } from '../../shared/types';
import type { DB } from '../db';

export type Ctx = {
  connectionId: string;
  config: Record<string, any>;       // non-secret config merged with decrypted secrets
  db: DB;
  cache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
};

export type ActionMessage = {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;     // rule, instrument, price, condition values, order …
};

export type PlacedOrder = { brokerOrderId: string | null; status: 'submitted' | 'open' | 'filled' | 'needs_confirmation'; fillPrice?: number | null; message?: string };

export interface DataSourceImpl {
  fetchSeries(ctx: Ctx, symbol: string, opts: { from?: string }): Promise<Bar[]>;
  quote?(ctx: Ctx, symbol: string): Promise<Quote>;
  test(ctx: Ctx): Promise<string>;
}

export interface NewsImpl {
  fetch(ctx: Ctx, q: { query?: string }): Promise<NewsItem[]>;
  test(ctx: Ctx): Promise<string>;
}

export interface ModelImpl {
  forecast?(ctx: Ctx, closes: number[], dates: string[], horizon: number): Promise<number[]>;
  complete?(ctx: Ctx, system: string, prompt: string): Promise<string>;
  test(ctx: Ctx): Promise<string>;
}

export interface ActionImpl {
  send(ctx: Ctx, msg: ActionMessage): Promise<string>;
  test(ctx: Ctx): Promise<string>;
}

export interface BrokerImpl {
  isLive(ctx: Ctx): boolean;
  accountId(ctx: Ctx): string;
  account(ctx: Ctx): Promise<Account>;
  positions(ctx: Ctx): Promise<Position[]>;
  placeOrder(ctx: Ctx, intent: OrderIntent, refPrice: number): Promise<PlacedOrder>;
  cancelAll(ctx: Ctx): Promise<number>;
  test(ctx: Ctx): Promise<string>;
}

export type PluginDef =
  | (PluginManifest & { kind: 'datasource'; impl: DataSourceImpl })
  | (PluginManifest & { kind: 'news'; impl: NewsImpl })
  | (PluginManifest & { kind: 'model'; impl: ModelImpl })
  | (PluginManifest & { kind: 'action'; impl: ActionImpl })
  | (PluginManifest & { kind: 'broker'; impl: BrokerImpl });

// ── Schema helpers ───────────────────────────────────────────────────────────
export const S = {
  str: (title: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', title, ...extra }),
  secret: (title: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', title, format: 'password', 'x-secret': true, ...extra }),
  url: (title: string, def?: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', title, format: 'uri', default: def, ...extra }),
  num: (title: string, def?: number, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'number', title, default: def, ...extra }),
  bool: (title: string, def = false, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'boolean', title, default: def, ...extra }),
  oneOf: (title: string, values: string[], def?: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', title, enum: values, default: def ?? values[0], ...extra }),
  text: (title: string, def?: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', title, format: 'textarea', default: def, ...extra }),
  json: (title: string, def?: string, extra: Partial<JSONSchema> = {}): JSONSchema => ({ type: 'string', title, format: 'json', default: def, ...extra }),
  obj: (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({ type: 'object', properties, required }),
};

export function secretFields(schema: JSONSchema): string[] {
  return Object.entries(schema.properties ?? {}).filter(([, s]) => s['x-secret']).map(([k]) => k);
}

export function need(config: Record<string, any>, ...keys: string[]) {
  const missing = keys.filter((k) => config[k] === undefined || config[k] === null || config[k] === '');
  if (missing.length) throw new Error(`Missing required setting: ${missing.join(', ')}`);
}
