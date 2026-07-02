/**
 * KB space-tree helpers — pure grouping logic behind the nested knowledge nav.
 *
 * Covers path canonicalization, tree building (direct vs subtree counts,
 * synthesized parents, sorting), and the subtree membership test used to filter
 * the team doc list when a category is opened.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSpacePath, buildSpaceTree, isSpaceInSubtree } from '../../apps/web/src/lib/knowledge-spaces';

describe('normalizeSpacePath', () => {
  it('falls back to "general" for empty/whitespace/nullish input', () => {
    expect(normalizeSpacePath('')).toBe('general');
    expect(normalizeSpacePath('   ')).toBe('general');
    expect(normalizeSpacePath(null)).toBe('general');
    expect(normalizeSpacePath(undefined)).toBe('general');
  });

  it('trims segments and collapses stray/duplicate slashes', () => {
    expect(normalizeSpacePath('eng')).toBe('eng');
    expect(normalizeSpacePath(' eng / backend ')).toBe('eng/backend');
    expect(normalizeSpacePath('/eng//backend/')).toBe('eng/backend');
  });
});

describe('buildSpaceTree', () => {
  it('groups a flat list with per-space direct counts', () => {
    const tree = buildSpaceTree([{ space: 'eng' }, { space: 'eng' }, { space: 'design' }]);
    expect(tree.map((n) => [n.name, n.count, n.total])).toEqual([
      ['design', 1, 1],
      ['eng', 2, 2],
    ]);
  });

  it('nests by "/" and synthesizes missing parent nodes', () => {
    const tree = buildSpaceTree([{ space: 'eng/backend' }, { space: 'eng/frontend' }]);
    expect(tree).toHaveLength(1);
    const eng = tree[0];
    expect([eng.name, eng.path, eng.count]).toEqual(['eng', 'eng', 0]); // parent has no direct docs
    expect(eng.children.map((c) => c.path)).toEqual(['eng/backend', 'eng/frontend']);
  });

  it('rolls descendant counts up into total while keeping direct count separate', () => {
    const tree = buildSpaceTree([{ space: 'eng' }, { space: 'eng/backend' }, { space: 'eng/backend/api' }]);
    const eng = tree[0];
    expect([eng.count, eng.total]).toEqual([1, 3]);
    const backend = eng.children[0];
    expect([backend.path, backend.count, backend.total]).toEqual(['eng/backend', 1, 2]);
  });

  it('buckets blank/whitespace spaces under "general"', () => {
    const tree = buildSpaceTree([{ space: '' }, { space: undefined }, { space: '  ' }]);
    expect(tree.map((n) => [n.path, n.count])).toEqual([['general', 3]]);
  });
});

describe('isSpaceInSubtree', () => {
  it('matches the space itself and any nested descendant', () => {
    expect(isSpaceInSubtree('eng', 'eng')).toBe(true);
    expect(isSpaceInSubtree('eng/backend', 'eng')).toBe(true);
    expect(isSpaceInSubtree('eng/backend/api', 'eng')).toBe(true);
  });

  it('does not match a sibling or a name that merely shares the prefix', () => {
    expect(isSpaceInSubtree('design', 'eng')).toBe(false);
    expect(isSpaceInSubtree('engineering', 'eng')).toBe(false); // 'eng' is not a path segment of 'engineering'
  });

  it('normalizes both sides before comparing', () => {
    expect(isSpaceInSubtree(' eng / backend ', '/eng/')).toBe(true);
  });
});
