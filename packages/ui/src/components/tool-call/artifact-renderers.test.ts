/**
 * GUARD + BEHAVIOR TEST — the chat artifact-renderer fork extension point.
 *
 * Upstream must ship ZERO fork renderers. The behavior tests prove the seam: a
 * registered renderer makes its call an inline artifact (isArtifactCall + partition)
 * without editing body-artifacts.tsx, and core artifact behavior is unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isArtifactCall, partitionCalls } from './body-artifacts';
import { ARTIFACT_RENDERERS, findArtifactRenderer, type ArtifactRenderer } from './artifact-renderers';

afterEach(() => {
  ARTIFACT_RENDERERS.length = 0;
});

describe('artifact renderer extension seam', () => {
  it('ships no fork renderers upstream (OSS invariant)', () => {
    expect(ARTIFACT_RENDERERS).toHaveLength(0);
  });

  it('an unknown tool is not an artifact when no renderer matches', () => {
    expect(isArtifactCall({ name: 'acme_report', output: { verdict: 'pass' } })).toBe(false);
  });

  it('a fork renderer makes its call an inline artifact', () => {
    const r: ArtifactRenderer = { match: (c) => c.name === 'acme_report', render: () => null };
    ARTIFACT_RENDERERS.push(r);
    expect(isArtifactCall({ name: 'acme_report', output: {} })).toBe(true);
    expect(findArtifactRenderer({ name: 'acme_report' })).toBe(r);
    const { trace, artifacts } = partitionCalls([{ name: 'acme_report', output: {} }, { name: 'other' }]);
    expect(artifacts.map((c) => c.name)).toEqual(['acme_report']);
    expect(trace.map((c) => c.name)).toEqual(['other']);
  });

  it('core artifact behavior is unchanged (update_page success stays an artifact)', () => {
    expect(isArtifactCall({ name: 'update_page', output: { success: true } })).toBe(true);
  });
});
