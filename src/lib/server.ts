// Client for the local Dhoomberg server. The browser never holds the server token: in dev
// the Vite proxy adds it, in production the server sets a SameSite=Strict cookie.
import { useEffect, useState } from 'react';
import type { HealthInfo, ServerEvent } from '../../shared/types';

export class ApiError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. CSV) */ }
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return (data ?? text) as T;
}

export const api = {
  get: <T>(path: string) => req<T>('GET', path),
  post: <T>(path: string, body?: unknown) => req<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => req<T>('PUT', path, body),
  del: <T>(path: string) => req<T>('DELETE', path),
};

// ── Online detection ─────────────────────────────────────────────────────────
let health: HealthInfo | null = null;
let probe: Promise<HealthInfo | null> | null = null;
const listeners = new Set<(h: HealthInfo | null) => void>();

export function refreshHealth(): Promise<HealthInfo | null> {
  probe = api.get<HealthInfo>('/health').then(
    (h) => { health = h; listeners.forEach((l) => l(h)); return h; },
    () => { health = null; listeners.forEach((l) => l(null)); return null; },
  );
  return probe;
}

export function serverOnline(): Promise<boolean> {
  return (probe ?? refreshHealth()).then((h) => !!h);
}

export function useHealth(): HealthInfo | null | undefined {
  const [h, setH] = useState<HealthInfo | null | undefined>(health ?? undefined);
  useEffect(() => {
    listeners.add(setH);
    if (!probe) refreshHealth();
    else probe.then(setH);
    const t = window.setInterval(refreshHealth, 15_000);
    return () => { listeners.delete(setH); window.clearInterval(t); };
  }, []);
  return h;
}

// ── Live events (SSE), shared by every subscriber ───────────────────────────
const evListeners = new Set<(e: ServerEvent) => void>();
let source: EventSource | null = null;

export function onServerEvent(fn: (e: ServerEvent) => void): () => void {
  evListeners.add(fn);
  if (!source) {
    source = new EventSource('/api/stream', { withCredentials: true });
    source.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as ServerEvent;
        if (e.type === 'halt' || e.type === 'connections' || e.type === 'plugins') refreshHealth();
        evListeners.forEach((l) => l(e));
      } catch { /* ignore */ }
    };
  }
  return () => {
    evListeners.delete(fn);
    if (!evListeners.size && source) { source.close(); source = null; }
  };
}

/** Re-runs `load` whenever one of the given server event types arrives. */
export function useServerData<T>(load: () => Promise<T>, events: ServerEvent['type'][], deps: unknown[] = []): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) { setData(d); setError(null); } }, (e: Error) => live && setError(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, ...deps]);
  useEffect(() => onServerEvent((e) => { if (events.includes(e.type)) setN((x) => x + 1); }), [events.join()]);
  return { data, error, reload: () => setN((x) => x + 1) };
}
