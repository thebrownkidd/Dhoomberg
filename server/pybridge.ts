// Long-lived Python worker for user plugins (plugins/*.py), spoken to over NDJSON on stdio.
// Calls time out; a timed-out or crashed worker is killed and restarted with backoff.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { PLUGINS_DIR, ROOT } from './paths';

export type PyManifest = {
  name: string;
  kind: 'indicator' | 'model' | 'datasource';
  title: string;
  params: Record<string, number | string | boolean>;
  description: string;
  file: string;
  pane?: 'overlay' | 'sub';
  outputs?: string[];
  levels?: number[];
  signal?: boolean;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class PyBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private backoff = 1000;
  private stopped = false;
  plugins: PyManifest[] = [];
  loadErrors: Record<string, string> = {};
  error: string | null = null;

  constructor(
    private python = process.env.DHOOMBERG_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    private dir = PLUGINS_DIR,
    private onChange: () => void = () => {},
  ) {}

  get available(): boolean {
    return !!this.proc && !this.error;
  }

  async start(): Promise<void> {
    this.stopped = false;
    mkdirSync(this.dir, { recursive: true });
    this.spawn();
    await this.refresh();
    this.watchDir();
  }

  stop() {
    this.stopped = true;
    this.proc?.kill();
  }

  private spawn() {
    const p = spawn(this.python, ['-u', '-m', 'dhoomberg_runtime.worker', this.dir], {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: [ROOT, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'), PYTHONIOENCODING: 'utf-8' },
    });
    this.proc = p;
    this.error = null;
    p.on('error', (e) => {
      this.error = `Python not available (${e.message}). Set DHOOMBERG_PYTHON to your interpreter.`;
      this.proc = null;
    });
    createInterface({ input: p.stdout }).on('line', (line) => {
      let msg: { id: number; result?: unknown; error?: string; trace?: string };
      try { msg = JSON.parse(line); } catch { return; }
      const w = this.pending.get(msg.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.pending.delete(msg.id);
      if (msg.error) w.reject(new Error(`Python plugin error: ${msg.error}`));
      else w.resolve(msg.result);
      this.backoff = 1000;
    });
    createInterface({ input: p.stderr }).on('line', (line) => console.log(`[py] ${line}`));
    p.on('exit', (code) => {
      for (const [, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error(`Python worker exited (code ${code})`)); }
      this.pending.clear();
      if (this.proc === p) this.proc = null;
      if (this.stopped || this.error) return;
      setTimeout(() => {
        if (this.stopped) return;
        this.spawn();
        this.refresh().catch(() => {});
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  private request<T>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error(this.error ?? 'Python worker is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Python plugin call timed out after ${timeoutMs / 1000}s; worker restarted`));
        this.proc?.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async refresh(reload = false): Promise<void> {
    try {
      const r = await this.request<{ plugins: PyManifest[]; errors: Record<string, string>; importError: string | null }>(reload ? 'reload' : 'list', {}, 60_000);
      this.plugins = r.plugins;
      this.loadErrors = r.errors;
      this.error = r.importError;
    } catch (e) {
      this.error ??= (e as Error).message;
      this.plugins = [];
    }
    this.onChange();
  }

  call<T>(plugin: string, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.request<T>('call', { plugin, args }, timeoutMs);
  }

  private watchDir() {
    if (!existsSync(this.dir)) return;
    let t: NodeJS.Timeout | null = null;
    try {
      watch(this.dir, { recursive: true }, (_ev, file) => {
        if (!file || !String(file).endsWith('.py')) return;
        if (t) clearTimeout(t);
        t = setTimeout(() => this.refresh(true).catch(() => {}), 500);
      });
    } catch { /* recursive watch unsupported: reload via the Settings button */ }
  }
}
