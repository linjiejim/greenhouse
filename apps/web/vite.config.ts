import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The API the dev server forwards /api (and the realtime socket) to. */
const api = process.env.GREENHOUSE_API ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target: api, ws: true }, '/health': { target: api } },
  },
  // The API serves the built app from the repo-root public/ (apps/api/src/http/web.ts).
  build: { manifest: true, outDir: '../../public', emptyOutDir: true },
});
