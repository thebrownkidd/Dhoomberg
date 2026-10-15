import { EventEmitter } from 'node:events';
import type { AuditEntry, ServerEvent } from '../shared/types';
import type { DB } from './db';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(e: ServerEvent) {
  bus.emit('event', e);
}

export function audit(db: DB, kind: string, detail: Record<string, unknown>, ruleId: string | null = null, ref: string | null = null): AuditEntry {
  const ts = new Date().toISOString();
  const r = db.prepare('INSERT INTO audit (ts, kind, rule_id, ref, detail) VALUES (?, ?, ?, ?, ?)').run(ts, kind, ruleId, ref, JSON.stringify(detail));
  const entry: AuditEntry = { id: Number(r.lastInsertRowid), ts, kind, ruleId, ref, detail };
  emit({ type: 'audit', entry });
  return entry;
}

export function readAudit(db: DB, opts: { limit?: number; before?: number; kind?: string } = {}): AuditEntry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.before) { where.push('id < ?'); args.push(opts.before); }
  if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
  const sql = `SELECT id, ts, kind, rule_id, ref, detail FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  args.push(Math.min(opts.limit ?? 200, 5000));
  return (db.prepare(sql).all(...args) as { id: number; ts: string; kind: string; rule_id: string | null; ref: string | null; detail: string }[]).map((r) => ({
    id: r.id, ts: r.ts, kind: r.kind, ruleId: r.rule_id, ref: r.ref, detail: JSON.parse(r.detail),
  }));
}
