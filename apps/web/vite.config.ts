/**
 * Vite config for the Greenhouse web UI.
 *
 * Dev: Vite dev server on :3100 (override with WEB_PORT) with HMR, proxying
 * /api (+ websocket), /public and /health to the API server on :3000 (override
 * with API_PORT — the proxy target follows it; see root `pnpm dev`). Same-origin
 * from the browser's POV, so authFetch/ws keep working without CORS.
 *
 * WEB_PORT/API_PORT are read from the repo-root `.env` (via loadEnv) with the
 * shell environment taking precedence, so a deployment can pin dev ports in
 * `.env` without editing this file.
 *
 * Build: emits the hashed bundle into the repo-root `public/`, where the API
 * serves it. `base: './'` keeps hashed assets relative to index.html.
 * `emptyOutDir: false` preserves the committed static files in `public/`; the
 * build pre-step removes every other legacy/generated artifact first.
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
  // mirroring @greenhouse/utils/brand on the server — so a deployment rebrands via
  // env without editing index.html. Empty/unset ⇒ "Greenhouse".
  const productName = env('PRODUCT_NAME') || 'Greenhouse';

  return {
    root: import.meta.dirname,
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'greenhouse-brand-title',
        transformIndexHtml: (html: string) => html.replace(/<title>[\s\S]*?<\/title>/, `<title>${productName}</title>`),
      },
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version || '0.0.0'),
      __GREENHOUSE_API_BASE_URL__: JSON.stringify(env('GREENHOUSE_API_BASE_URL') || ''),
      __PRODUCT_NAME__: JSON.stringify(productName),
    },
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, ws: true },
        '/public': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
        '/favicon.ico': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: resolve(repoRoot, 'public'),
      emptyOutDir: false,
      // Source maps are opt-in: the API serves /assets without auth, so publishing
      // them by default would disclose application source with no upload consumer.
      sourcemap: env('WEB_BUILD_SOURCEMAP') === 'true',
      chunkSizeWarningLimit: 1500,
    },
  };
});
