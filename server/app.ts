import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import Fastify from 'fastify';
import { loadToken, makeAuthHook, sessionCookie } from './auth';
import { openDb } from './db';
import { emit } from './events';
import { Market } from './market';
import { Executor } from './orders/executor';
import { DIST_DIR } from './paths';
import { PyBridge } from './pybridge';
import { Registry } from './registry';
import { registerRoutes } from './routes';
import { RuleEngine } from './rules/engine';
import { AnalystService, ModelService, NewsService } from './services';
import { Vault } from './vault';

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function createApp(opts: { pluginsDir?: string } = {}) {
  const db = openDb();
  const vault = new Vault(db);
  const token = loadToken();
  const py = new PyBridge(undefined, opts.pluginsDir, () => emit({ type: 'plugins' }));
  const reg = new Registry(db, vault, py);
  const market = new Market(db, reg);
  const news = new NewsService(reg);
  const models = new ModelService(reg, market, py);
  const analyst = new AnalystService(reg, market, news);
  const executor = new Executor(db, reg, market);
  const rules = new RuleEngine({ db, reg, market, py, news, models, analyst, executor });

  const app = Fastify({ bodyLimit: 15 * 1024 * 1024, logger: { level: process.env.DHOOMBERG_LOG ?? 'warn' } });
  app.addHook('onRequest', makeAuthHook(token));
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 400;
    reply.code(status).send({ error: err.message });
  });
  registerRoutes(app, { db, reg, market, py, news, models, analyst, executor, rules });

  // Production: serve the built terminal from the same origin and hand it a session cookie.
  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Unknown API route' });
    if (!existsSync(DIST_DIR)) return reply.code(404).send('Run `npm run build` first, or use `npm start` for the dev UI on :5173.');
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
    let file = join(DIST_DIR, rel);
    if (!file.startsWith(DIST_DIR) || !existsSync(file) || rel === '' || extname(file) === '') file = join(DIST_DIR, 'index.html');
    if (file.endsWith('index.html')) reply.header('Set-Cookie', sessionCookie(token));
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
  });

  return { app, token, db, vault, py, reg, market, news, models, analyst, executor, rules };
}
