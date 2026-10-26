/** Production SPA hosting. API, upload and plugin paths never fall through to HTML. */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import type { AppEnv } from './app-env.js';

export function mountClientHosting(app: Hono<AppEnv>, publicDir: string, mode: 'classic' | 'universal') {
  const sharedIcons = new Set([
    '/favicon.ico',
    '/favicon.svg',
    '/apple-touch-icon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/site.webmanifest',
  ]);
  app.get('/classic', (c) => c.redirect('/classic/', 308));
  app.get('*', async (c, next) => {
    const path = c.req.path;
    if (/^\/(api|ext|oauth|\.well-known)(\/|$)/.test(path) || path === '/health') return next();
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return c.body(null, 404);
    }
    if (decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) return c.body(null, 404);
    const classic = path.startsWith('/classic/');
    const shared = path.startsWith('/public/');
    const root = resolve(
      publicDir,
      !classic && !shared && !sharedIcons.has(path) && mode === 'universal' ? 'app' : '.',
    );
    const requestPath = classic ? decoded.slice('/classic'.length) : shared ? decoded.slice('/public'.length) : decoded;
    // public/app is an output directory, never a second route to the universal application.
    if (shared && requestPath.startsWith('/app/')) return c.body(null, 404);
    const local = resolve(root, '.' + requestPath);
    if (local !== root && !local.startsWith(root + sep)) return c.body(null, 404);
    if (existsSync(local) && statSync(local).isFile()) {
      c.header(
        'Cache-Control',
        /(?:\/assets\/|\/_expo\/).*[-\w]{8,}\./.test(local)
          ? 'public, max-age=31536000, immutable'
          : extname(local) === '.html'
            ? 'no-cache'
            : 'public, max-age=3600',
      );
      return serveStatic({
        root,
        rewriteRequestPath: () => requestPath,
      })(c, next);
    }
    if (path === '/favicon.ico') return c.body(null, 204);
    if (shared || extname(requestPath)) return c.body(null, 404);
    const index = resolve(root, 'index.html');
    if (!existsSync(index))
      return c.text(`Frontend not built. Run: pnpm ${classic || mode === 'classic' ? 'web:build' : 'app:build'}`, 404);
    let html = readFileSync(index, 'utf8');
    // The hash client has relative Vite assets. A fixed base keeps SPA fallback
    // at /classic/deep/path and its historical hashes working after relocation.
    if (classic || mode === 'classic')
      html = html.replace('<head>', `<head><base href="${classic ? '/classic/' : '/'}">`);
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  });
}
