import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
// Served by the host at /ext/assets/ui/; the bridge, protocol and theme come straight from the repo.
export default defineConfig({
  base: '/ext/assets/ui/',
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@greenhouse/ui-tokens/tailwind.css', replacement: resolve(repo, 'packages/ui-tokens/tailwind.css') },
      { find: '@greenhouse/ui-tokens', replacement: resolve(repo, 'packages/ui-tokens/src/index.ts') },
      { find: /^@greenhouse\/types\/(.*)$/, replacement: resolve(repo, 'packages/types/src/$1') },
    ],
  },
  build: { outDir: '../ui/dist', emptyOutDir: true },
  worker: { format: 'es' },
  server: { fs: { allow: [repo] } },
});
