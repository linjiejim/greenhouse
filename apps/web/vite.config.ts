/**
 * Vite config for the Greenhouse web UI.
 *
 * Dev: Vite dev server on :3100 with HMR, proxying /api (+ websocket), /public
 * and /health to the API server on :3101 (see root `pnpm dev`). Same-origin from
 * the browser's POV, so authFetch/ws keep working without CORS.
 *
 * Build: emits the hashed bundle into the repo-root `public/` (where the API
 * static server, the Electron packaging step and the hot-update publisher all
 * already look). `base: './'` keeps asset refs relative so the SAME index.html
 * works both served at `/` by the API and loaded as a file:// document.
 * `emptyOutDir: false` so the build never wipes co-located static files; the
 * build script clears `public/assets` itself.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'));
const apiTarget = `http://localhost:${process.env.API_PORT || 3101}`;

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || '0.0.0'),
    __GREENHOUSE_API_BASE_URL__: JSON.stringify(process.env.GREENHOUSE_API_BASE_URL || ''),
  },
  server: {
    port: 3100,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, ws: true },
      '/public': { target: apiTarget, changeOrigin: true },
      '/health': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(repoRoot, 'public'),
    emptyOutDir: false,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
