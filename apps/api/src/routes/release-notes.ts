/**
 * Release notes — GET /public/release-notes.json, GET /public/release-notes-history.json
 *
 * The web app (browser and desktop shell) asks for both on every load to fill
 * the "what's new" dialog. Only a web bundle built by the release pipeline
 * (`scripts/desktop/release-notes.mjs`) carries them; `pnpm dev` and a plain
 * `web:build` do not. "This deployment publishes no release notes" is an
 * answer, not a missing resource: 204 instead of a 404 that every page load
 * would log as a failed request. Registered before the generic `/public/*`
 * static handler; a present file is served as-is, never cached (it changes
 * with each bundle under the same name).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';

export const RELEASE_NOTES_FILES = ['release-notes.json', 'release-notes-history.json'] as const;

export function createReleaseNotesRoutes(publicDir: string) {
  const routes = new Hono();
  for (const file of RELEASE_NOTES_FILES) {
    routes.get(`/public/${file}`, (c) => {
      const path = resolve(publicDir, file);
      if (!existsSync(path)) return c.body(null, 204);
      c.header('Content-Type', 'application/json; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      return c.body(readFileSync(path));
    });
  }
  return routes;
}
