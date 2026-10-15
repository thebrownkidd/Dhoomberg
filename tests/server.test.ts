import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Isolated data dir: must be set before server modules are imported.
process.env.DHOOMBERG_DATA_DIR = mkdtempSync(join(tmpdir(), 'dhoomberg-test-'));

const { createApp } = await import('../server/app');
const built = createApp({ pluginsDir: join(process.env.DHOOMBERG_DATA_DIR, 'no-plugins') });
const { app, token, db } = built;

const SECRET = 'xoxb-SUPER-SECRET-VALUE-123456789';
const bodies: string[] = [];

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as never, url,
    headers: { host: '127.0.0.1:8787', 'x-dhoomberg-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  bodies.push(res.body);
  return { status: res.statusCode, json: () => JSON.parse(res.body), body: res.body };
}

beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); });

describe('access control', () => {
  it('rejects requests without the token', async () => {
    expect((await call('GET', '/api/health', undefined, { 'x-dhoomberg-token': '' })).status).toBe(401);
  });
  it('rejects a wrong token', async () => {
    expect((await call('GET', '/api/health', undefined, { 'x-dhoomberg-token': 'nope' })).status).toBe(401);
  });
  it('rejects foreign origins even with the token', async () => {
    expect((await call('GET', '/api/health', undefined, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('rejects non-local Host headers (DNS rebinding)', async () => {
    expect((await call('GET', '/api/health', undefined, { host: 'evil.example:8787' })).status).toBe(403);
  });
  it('rejects state changes that are not JSON (cross-site form posts)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/halt', headers: { host: '127.0.0.1:8787', 'x-dhoomberg-token': token, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=1' });
    expect(r.statusCode).toBe(415);
  });
  it('accepts the terminal origin', async () => {
    expect((await call('GET', '/api/health', undefined, { origin: 'http://localhost:5173' })).status).toBe(200);
  });
});

describe('vault', () => {
  let id = '';
  it('stores secrets encrypted and only returns a mask', async () => {
    const r = await call('POST', '/api/connections', { pluginId: 'slack', name: 'Desk', config: { webhookUrl: SECRET } });
    expect(r.status).toBe(200);
    id = r.json().id;
    expect(r.json().secrets.webhookUrl).toBe('●●●●6789');
    const row = db.prepare('SELECT data FROM secrets WHERE connection_id = ?').get(id) as { data: Uint8Array };
    expect(Buffer.from(row.data).toString('utf8')).not.toContain('SECRET');
    expect(built.vault.get(id, 'webhookUrl')).toBe(SECRET);
  });
  it('keeps the secret when the masked value is sent back', async () => {
    await call('PUT', `/api/connections/${id}`, { config: { webhookUrl: '●●●●6789' } });
    expect(built.vault.get(id, 'webhookUrl')).toBe(SECRET);
  });
  it('detects tampering (GCM auth tag)', () => {
    db.prepare('UPDATE secrets SET data = ? WHERE connection_id = ?').run(Buffer.from('tampered!!'), id);
    expect(() => built.vault.get(id, 'webhookUrl')).toThrow();
    built.vault.set(id, 'webhookUrl', SECRET);
  });
  it('never includes secrets in config export', async () => {
    const r = await call('GET', '/api/config/export');
    expect(r.body).not.toContain(SECRET);
    expect(r.json().connections[0].secretFields).toEqual(['webhookUrl']);
  });
});

describe('paper trading flow', () => {
  let paper = '';
  it('creates a paper broker', async () => {
    const r = await call('POST', '/api/connections', { pluginId: 'paper', name: 'Paper', config: { startingCash: 100000 } });
    paper = r.json().id;
    expect((await call('POST', `/api/connections/${paper}/test`, {})).json().ok).toBe(true);
  });
  it('fills a manual market order and updates the position', async () => {
    const o = (await call('POST', '/api/orders', { connectionId: paper, instrument: 'SUGAR', side: 'buy', qty: 1000, orderType: 'market', tif: 'day' })).json();
    expect(o.status).toBe('filled');
    expect(o.mode).toBe('paper');
    const pf = (await call('GET', '/api/portfolio')).json();
    const pos = pf.find((p: { connectionId: string }) => p.connectionId === paper).positions[0];
    expect(pos.instrument).toBe('SUGAR');
    expect(pos.qty).toBe(1000);
  });
  it('the guard rejects an oversized order and records why', async () => {
    const o = (await call('POST', '/api/orders', { connectionId: paper, instrument: 'GOLD', side: 'buy', qty: 100, orderType: 'market', tif: 'day' })).json();
    expect(o.status).toBe('rejected');
    expect(o.reason).toMatch(/per-order limit/);
  });
  it('a limit order outside the band is rejected', async () => {
    const o = (await call('POST', '/api/orders', { connectionId: paper, instrument: 'SUGAR', side: 'buy', qty: 10, orderType: 'limit', limitPrice: 0.01, tif: 'day' })).json();
    expect(o.status).toBe('rejected');
  });
  it('HALT blocks the next order; RESUME re-enables', async () => {
    expect((await call('POST', '/api/halt', { reason: 'test' })).json().halted).toBe(true);
    const o = (await call('POST', '/api/orders', { connectionId: paper, instrument: 'SUGAR', side: 'sell', qty: 10, orderType: 'market', tif: 'day' })).json();
    expect(o.status).toBe('rejected');
    expect(o.reason).toMatch(/halted/);
    await call('POST', '/api/resume', {});
    const o2 = (await call('POST', '/api/orders', { connectionId: paper, instrument: 'SUGAR', side: 'sell', qty: 10, orderType: 'market', tif: 'day' })).json();
    expect(o2.status).toBe('filled');
  });
  it('a rule in confirm mode creates an approval, and approval re-checks the guard', async () => {
    const rule = (await call('POST', '/api/rules', {
      name: 'Always', enabled: false, mode: 'confirm', cooldownMin: 0, cadence: { type: 'tick' },
      when: { kind: 'group', mode: 'all', items: [{ kind: 'cond', left: { type: 'price', instrument: 'SUGAR' }, op: '>', right: { type: 'const', value: 0 } }] },
      actions: [{ type: 'order', connectionId: paper, instrument: 'SUGAR', side: 'buy', qty: 5, orderType: 'market', tif: 'day' }],
    })).json();
    const ev = await built.rules.evaluate(rule);
    expect(ev.result).toBe(true);
    await built.rules.fire(rule, ev);
    const pending = (await call('GET', '/api/approvals')).json().filter((a: { status: string }) => a.status === 'pending');
    expect(pending).toHaveLength(1);
    const res = (await call('POST', `/api/approvals/${pending[0].id}/approve`, {})).json();
    expect(res.order.status).toBe('filled');
    expect((await call('POST', `/api/approvals/${pending[0].id}/approve`, {})).status).toBe(400);
  });
  it('live mode cannot be armed on a paper broker', async () => {
    expect((await call('POST', `/api/brokers/${paper}/arm`, { accountId: 'x' })).status).toBe(400);
  });
});

describe('audit log', () => {
  it('records every order outcome', async () => {
    const kinds = (await call('GET', '/api/audit?limit=500')).json().map((e: { kind: string }) => e.kind);
    for (const k of ['order_filled', 'order_rejected', 'halt', 'resume', 'approval_requested', 'approval_approved', 'rule_fired']) expect(kinds).toContain(k);
  });
  it('is append-only at the database level', () => {
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE audit SET kind = 'x'").run()).toThrow(/append-only/);
  });
});

describe('rules + backtest', () => {
  it('validates rules', async () => {
    expect((await call('POST', '/api/rules', { name: '', when: { kind: 'group', mode: 'all', items: [] } })).status).toBe(400);
  });
  it('backtests with directional forward returns and an honest note', async () => {
    const r = (await call('POST', '/api/rules/backtest', {
      rule: { when: { kind: 'group', mode: 'all', items: [{ kind: 'cond', left: { type: 'indicator', instrument: 'COCOA', indicator: 'rsi', params: { period: 14 } }, op: 'crosses_below', right: { type: 'const', value: 30 } }] }, actions: [] },
      horizonBars: 10,
    })).json();
    expect(r.bars).toBeGreaterThan(1000);
    expect(r.fires.length).toBeGreaterThan(0);
    expect(r.note).toMatch(/In-sample/);
    expect(r.forwardReturn.baselineAvg).not.toBeNull();
  });
});

describe('secrets never leak', () => {
  it('no API response in this run contained a plaintext secret', () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain(SECRET);
  });
});
