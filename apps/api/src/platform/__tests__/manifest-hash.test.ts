/**
 * Golden manifest hashes — the guard for the one platform failure CI cannot see.
 *
 * `publishAppRelease` refuses to republish `<app>@<version>` when the manifest
 * serializes to a different hash than the row already stored. Every test and CI
 * run starts from an empty database, so there is never a stored row to clash
 * with: a manifest edit that forgets its version bump passes every gate and then
 * **kills the API at boot** on the first environment that already has the old
 * hash. That is not hypothetical — 2026-08-11's deploy took the dev box down
 * with `应用 projects@1.0.0 已存在且 manifest hash 不同`, from a change that only
 * reordered a key inside each action object (`{id, ...action}` →
 * `{...action, id}`), altering no behaviour at all.
 *
 * So the hash is pinned here instead. If this test fails you changed what a
 * manifest serializes to — **bump that manifest's `version`, then update the
 * hash below**. Both, in the same commit: the version is what lets the new
 * manifest be published, the hash is what keeps this guard honest.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { knowledgeManifest } from '../manifests/knowledge.js';
import { projectsManifest } from '../manifests/projects.js';
import { tablesManifest } from '../manifests/tables.js';

// Same computation as packages/db `manifestPayload()` — the manifests are
// already compiled at their definition site, so this is the exact byte stream
// the release row stores.
function manifestHash(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

const GOLDEN: ReadonlyArray<{ manifest: { id: string; version: string }; hash: string }> = [
  { manifest: knowledgeManifest, hash: '3c5ebe45220a613baf5fb68d525d1da04b9ce3fb5ff72ce96d2923dcdf83e0f1' },
  { manifest: projectsManifest, hash: '5c59dd1e110b4fb77259309031b077c2878a9d64335b07ed2b1a79da93d1731d' },
  { manifest: tablesManifest, hash: 'f6c589dd079db53c8ae223c014696f59cb7928c7447d1b360baefee05028aed3' },
];

describe('platform manifest hashes', () => {
  it.each(GOLDEN.map((g) => [`${g.manifest.id}@${g.manifest.version}`, g] as const))(
    '%s serializes to its pinned hash',
    (_label, golden) => {
      expect(manifestHash(golden.manifest)).toBe(golden.hash);
    },
  );

  it('never publishes two apps under the same id', () => {
    const ids = GOLDEN.map((g) => g.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
