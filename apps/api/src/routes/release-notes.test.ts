/**
 * The release-notes files are optional (only release-pipeline bundles carry
 * them), and every page load asks for both: a deployment without them answers
 * 204 instead of a 404 the browser logs as a failed request on every load.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReleaseNotesRoutes, RELEASE_NOTES_FILES } from './release-notes.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-release-notes-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('release notes routes', () => {
  it('answers 204 when the bundle carries no release notes', async () => {
    const routes = createReleaseNotesRoutes(dir);
    for (const file of RELEASE_NOTES_FILES) {
      const response = await routes.request(`/public/${file}`);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    }
  });

  it('serves the files a release bundle wrote, uncached', async () => {
    writeFileSync(join(dir, 'release-notes.json'), '{"title":"v1.4"}');
    const response = await createReleaseNotesRoutes(dir).request('/public/release-notes.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ title: 'v1.4' });
  });
});
