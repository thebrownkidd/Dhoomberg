import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The dev proxy is the only thing that can read the local server token (written by
// server/auth.ts), so the browser never holds it and other sites cannot use it.
const TOKEN_FILE = resolve(__dirname, process.env.DHOOMBERG_DATA_DIR ?? '.dhoomberg', 'token');
const API = `http://127.0.0.1:${process.env.DHOOMBERG_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API,
        changeOrigin: false,
        configure(proxy) {
          proxy.on('proxyReq', (req) => {
            if (existsSync(TOKEN_FILE)) req.setHeader('X-Dhoomberg-Token', readFileSync(TOKEN_FILE, 'utf8').trim());
          });
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
