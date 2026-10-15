// Secrets at rest: AES-256-GCM, key from DHOOMBERG_MASTER_KEY (64 hex chars) or a
// random key file created on first run with owner-only permissions. Plaintext secrets
// never leave the server; the API only exposes a masked hint.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db';
import { DATA_DIR } from './paths';

function loadKey(): Buffer {
  const env = process.env.DHOOMBERG_MASTER_KEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error('DHOOMBERG_MASTER_KEY must be 64 hex characters');
    return Buffer.from(env, 'hex');
  }
  const file = join(DATA_DIR, 'master.key');
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* Windows: ACLs inherit from the user profile */ }
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

export function mask(value: string): string {
  return value.length <= 4 ? '●●●●' : `●●●●${value.slice(-4)}`;
}

export class Vault {
  private key: Buffer;
  constructor(private db: DB, key?: Buffer) {
    this.key = key ?? loadKey();
  }

  set(connectionId: string, field: string, value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`${connectionId}:${field}`));
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    this.db
      .prepare('INSERT INTO secrets (connection_id, field, iv, tag, data, hint) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id, field) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, hint = excluded.hint')
      .run(connectionId, field, iv, c.getAuthTag(), data, mask(value));
  }

  get(connectionId: string, field: string): string | null {
    const row = this.db.prepare('SELECT iv, tag, data FROM secrets WHERE connection_id = ? AND field = ?').get(connectionId, field) as
      | { iv: Uint8Array; tag: Uint8Array; data: Uint8Array }
      | undefined;
    if (!row) return null;
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv));
    d.setAAD(Buffer.from(`${connectionId}:${field}`));
    d.setAuthTag(Buffer.from(row.tag));
    return Buffer.concat([d.update(Buffer.from(row.data)), d.final()]).toString('utf8');
  }

  all(connectionId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT field FROM secrets WHERE connection_id = ?').all(connectionId) as { field: string }[];
    return Object.fromEntries(rows.map((r) => [r.field, this.get(connectionId, r.field)!]));
  }

  hints(connectionId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT field, hint FROM secrets WHERE connection_id = ?').all(connectionId) as { field: string; hint: string }[];
    return Object.fromEntries(rows.map((r) => [r.field, r.hint]));
  }

  remove(connectionId: string, field?: string) {
    if (field) this.db.prepare('DELETE FROM secrets WHERE connection_id = ? AND field = ?').run(connectionId, field);
    else this.db.prepare('DELETE FROM secrets WHERE connection_id = ?').run(connectionId);
  }
}
