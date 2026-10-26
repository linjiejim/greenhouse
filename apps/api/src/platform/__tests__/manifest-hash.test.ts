/**
 * Golden manifest hashes — a manifest's serialized form is fixed per version.
 *
 * 3.0 no longer stores app releases, so nothing fails at boot when a manifest
 * changes without a version bump; clients, extensions and audit summaries
 * still read `<app>@<version>` as a promise about what the app declares. The
 * hash is pinned here so that promise holds. If this test fails you changed
 * what a manifest serializes to — **bump that manifest's `version`, then
 * update the hash below**, in the same commit.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { knowledgeManifest } from '../manifests/knowledge.js';

// Same computation as packages/db `manifestPayload()` — the manifests are
// already compiled at their definition site, so this is the exact byte stream
// the release row stores.
function manifestHash(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

const GOLDEN: ReadonlyArray<{ manifest: { id: string; version: string }; hash: string }> = [
  { manifest: knowledgeManifest, hash: '913cee0b0477d9df728edaf231096070eb58d17f113aa043a6a476c08e0c2759' },
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
