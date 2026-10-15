import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { DATA_DIR } from './paths';

// Loaded via require: Vite (used by vitest) rewrites the newer `node:sqlite` builtin to `sqlite`.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, name TEXT NOT NULL,
  config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, last_test TEXT
);

CREATE TABLE IF NOT EXISTS secrets (
  connection_id TEXT NOT NULL, field TEXT NOT NULL,
  iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL, hint TEXT NOT NULL,
  PRIMARY KEY (connection_id, field)
);

CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, unit TEXT NOT NULL,
  dp INTEGER NOT NULL, multiplier REAL NOT NULL, connection_id TEXT NOT NULL, symbol TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, json TEXT NOT NULL, state TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL,
  instrument TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, notional REAL NOT NULL,
  json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS paper_positions (
  connection_id TEXT NOT NULL, instrument TEXT NOT NULL, symbol TEXT NOT NULL,
  qty REAL NOT NULL, avg_price REAL NOT NULL, PRIMARY KEY (connection_id, instrument)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
  rule_id TEXT, ref TEXT, detail TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);
`;

export function openDb(file = join(DATA_DIR, 'dhoomberg.db')): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function kvGet<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function kvSet(db: DB, key: string, value: unknown) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
