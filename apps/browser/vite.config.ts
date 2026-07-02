/**
 * Vite config for the Greenhouse browser extension (MV3).
 *
 * Three entries share one build: the side panel and options pages (HTML +
 * React) plus the background service worker (plain ESM — MV3 `type: module`
 * lets it import shared hashed chunks). `public/manifest.json` is copied
 * verbatim into `dist/`, which is what you point "Load unpacked" at.
 *
 * There is no dev server — extensions must be loaded from disk, so `pnpm dev`
 * is `vite build --watch` + manual reload of the extension in Chrome.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        options: resolve(import.meta.dirname, 'options.html'),
        background: resolve(import.meta.dirname, 'src/background/index.ts'),
      },
      output: {
        // The manifest points at a stable filename for the service worker;
        // everything else keeps Vite's hashed asset names.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
