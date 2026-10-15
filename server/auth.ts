// The server controls API keys and can place orders, so every request must prove it
// comes from this machine's terminal:
//  1. bound to 127.0.0.1 only (index.ts)
//  2. Host header must be localhost/127.0.0.1 (blocks DNS rebinding)
//  3. Origin, when present, must be an allowed terminal origin (blocks other websites)
//  4. a per-install token, via X-Dhoomberg-Token (Vite proxy / CLI) or a SameSite=Strict cookie
//  5. POSTs must be application/json (no simple cross-site form posts); PUT/DELETE always preflight
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DATA_DIR, PORT } from './paths';

export const TOKEN_FILE = join(DATA_DIR, 'token');

export function loadToken(): string {
  if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

const VITE_PORT = Number(process.env.DHOOMBERG_UI_PORT ?? 5173);
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  for (const h of LOCAL_HOSTS) for (const p of [VITE_PORT, PORT, 4173]) out.add(`http://${h}:${p}`);
  for (const o of (process.env.DHOOMBERG_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) out.add(o);
  return out;
}

function hostOk(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTS.includes(name);
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'dhb_session' && v) return decodeURIComponent(v);
  }
  return null;
}

export function makeAuthHook(token: string) {
  const origins = allowedOrigins();
  return async function auth(req: FastifyRequest, reply: FastifyReply) {
    if (!req.url.startsWith('/api/')) return;
    if (!hostOk(req.headers.host)) return reply.code(403).send({ error: 'Host not allowed' });
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return reply.code(403).send({ error: 'Origin not allowed' });
    const supplied = (req.headers['x-dhoomberg-token'] as string | undefined) ?? cookieToken(req);
    if (!supplied || !safeEq(supplied, token)) return reply.code(401).send({ error: 'Missing or invalid token' });
    // POST is the only state-changing method a foreign page can send without a CORS preflight.
    if (req.method === 'POST') {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.startsWith('application/json')) return reply.code(415).send({ error: 'Content-Type must be application/json' });
    }
  };
}

export function sessionCookie(token: string): string {
  return `dhb_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}
