/**
 * The built web app: `pnpm web:build` writes it to the repo-root public/. index.html is never
 * cached, so a deploy shows on the next load; the hashed files under /assets are cached for
 * good. Only GET and HEAD outside /api reach here.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { AppEnv } from './env.js';

export const PUBLIC_DIR = fileURLToPath(new URL('../../../../public', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Scripts only from this origin; inline styles for React style attributes; previews in blob frames. */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function webRoutes(dir: string = PUBLIC_DIR) {
  const root = normalize(dir);
  return new Hono<AppEnv>().on(['GET', 'HEAD'], '*', async (c, next) => {
    const path = c.req.path;
    if (path === '/health' || path === '/api' || path.startsWith('/api/')) return next();
    let relative: string;
    try {
      relative = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    } catch {
      return next();
    }
    const file = normalize(join(root, relative));
    const type = TYPES[extname(file)];
    if (!file.startsWith(root + sep) || !type) return next();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return next();

    c.header('Content-Type', type);
    c.header('Content-Length', String(info.size));
    if (relative === 'index.html') {
      c.header('Cache-Control', 'no-cache');
      c.header('Content-Security-Policy', PAGE_POLICY);
    } else {
      c.header(
        'Cache-Control',
        relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      );
    }
    if (c.req.method === 'HEAD') return c.body(null, 200);
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200);
  });
}
