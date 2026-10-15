import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DHOOMBERG_DATA_DIR ? resolve(process.env.DHOOMBERG_DATA_DIR) : join(ROOT, '.dhoomberg');
export const PLUGINS_DIR = process.env.DHOOMBERG_PLUGINS_DIR ? resolve(process.env.DHOOMBERG_PLUGINS_DIR) : join(ROOT, 'plugins');
export const PUBLIC_DIR = join(ROOT, 'public');
export const DIST_DIR = join(ROOT, 'dist');

mkdirSync(DATA_DIR, { recursive: true });

export const PORT = Number(process.env.DHOOMBERG_PORT ?? 8787);
export const HOST = '127.0.0.1';
