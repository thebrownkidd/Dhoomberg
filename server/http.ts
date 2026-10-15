import { Agent, fetch as undiciFetch } from 'undici';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

export type FetchOpts = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  insecureTls?: boolean;     // self-signed local gateways (IBKR Client Portal)
};

export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers: { 'User-Agent': 'Dhoomberg/0.2 (+local terminal)', ...opts.headers },
      body: opts.body,
      signal: ctrl.signal,
    };
    const res = opts.insecureTls
      ? ((await undiciFetch(url, { ...(init as object), dispatcher: insecureAgent } as never)) as unknown as Response)
      : await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `${res.status} ${res.statusText} from ${new URL(url).host}: ${text.slice(0, 300)}`, text);
    }
    return res;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Timed out calling ${new URL(url).host}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  return (await res.json()) as T;
}

export async function postJson<T = unknown>(url: string, body: unknown, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, {
    ...opts,
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...opts.headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** `{name}` placeholders. URL mode encodes values; unknown names become empty strings. */
export function render(tpl: string, vars: Record<string, unknown>, mode: 'url' | 'raw' = 'raw'): string {
  return tpl.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, k: string) => {
    const v = k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), vars);
    const s = v === undefined || v === null ? '' : String(v);
    return mode === 'url' ? encodeURIComponent(s) : s;
  });
}

/** `{{name}}` placeholders for message bodies; `json` mode escapes for embedding inside JSON strings. */
export function renderMessage(tpl: string, vars: Record<string, unknown>, mode: 'text' | 'json' = 'text'): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k: string) => {
    const v = k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), vars);
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return mode === 'json' ? JSON.stringify(s).slice(1, -1) : s;
  });
}

/** Path like `a.b[0].c`, `["Time Series (Daily)"]`, `[4]`, or `$`/'' for the root. */
export function pluck(obj: unknown, path: string | undefined): unknown {
  if (!path || path === '$') return obj;
  const re = /\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]|\.?([^.[\]]+)/g;
  let cur: unknown = obj;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (cur === null || cur === undefined) return undefined;
    const key = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (key === '$') continue;
    cur = (cur as Record<string, unknown>)[m[1] !== undefined ? Number(key) : key];
  }
  return cur;
}

export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.replace(/,/g, '').trim();
  if (!s || s === '.' || /^(na|n\/a|null|-)$/i.test(s)) return NaN;
  return Number(s);
}

/** Normalise the date formats APIs actually return to ISO. */
export function toIso(v: unknown, dateOnly = true): string | null {
  let d: Date | null = null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,19}$/.test(v))) {
    const n = Number(v);
    d = new Date(n > 1e17 ? n / 1e6 : n > 1e11 ? n : n * 1000);
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    if (/^\d{4}$/.test(s)) return dateOnly ? `${s}-12-31` : `${s}-12-31T00:00:00Z`;
    const c = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z?$/.exec(s);
    if (c) d = new Date(Date.UTC(+c[1], +c[2] - 1, +c[3], +c[4], +c[5], +(c[6] ?? 0)));
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dateOnly ? s : `${s}T00:00:00Z`;
    else {
      const t = Date.parse(s);
      if (!Number.isNaN(t)) d = new Date(t);
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return dateOnly ? d.toISOString().slice(0, 10) : d.toISOString();
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

export function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 400);
}
