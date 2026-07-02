/**
 * Vite config for the Greenhouse web UI.
 *
 * Dev: Vite dev server on :3100 (override with WEB_PORT) with HMR, proxying
 * /api (+ websocket), /public and /health to the API server on :3000 (override
 * with API_PORT — the proxy target follows it; see root `pnpm dev`). Same-origin
 * from the browser's POV, so authFetch/ws keep working without CORS.
 *
 * WEB_PORT/API_PORT are read from the repo-root `.env` (via loadEnv) with the
 * shell environment taking precedence, so a fork can pin dev ports in `.env`
 * without editing this file.
 *
 * Build: emits the hashed bundle into the repo-root `public/` (where the API
 * static server, the Electron packaging step and the hot-update publisher all
 * already look). `base: './'` keeps asset refs relative so the SAME index.html
 * works both served at `/` by the API and loaded as a file:// document.
 * `emptyOutDir: false` so the build never wipes co-located static files; the
 * build script clears `public/assets` itself.
 */

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'));

export default defineConfig(({ mode }) => {
  // Load the repo-root `.env` (all keys, no VITE_ prefix filter). Shell env wins
  // over the file so `WEB_PORT=... pnpm dev` still overrides a pinned `.env`.
  const fileEnv = loadEnv(mode, repoRoot, '');
  const env = (key: string) => process.env[key] || fileEnv[key];

  const webPort = Number(env('WEB_PORT')) || 3100;
  const apiTarget = `http://localhost:${env('API_PORT') || 3000}`;

  // White-label seam: the document title follows PRODUCT_NAME (default "Greenhouse"),
  // mirroring @greenhouse/utils/brand on the server — so a fork rebrands via env
  // without editing index.html. Empty/unset ⇒ identical to upstream.
  const productName = env('PRODUCT_NAME') || 'Greenhouse';

  return {
    root: import.meta.dirname,
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'greenhouse-brand-title',
        transformIndexHtml: (html) => html.replace(/<title>[\s\S]*?<\/title>/, `<title>${productName}</title>`),
      },
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version || '0.0.0'),
      __GREENHOUSE_API_BASE_URL__: JSON.stringify(env('GREENHOUSE_API_BASE_URL') || ''),
      // Runtime default for BRANDING.productName (branding.extensions.tsx).
      __PRODUCT_NAME__: JSON.stringify(productName),
    },
    server: {
      port: webPort,
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
  };
});
