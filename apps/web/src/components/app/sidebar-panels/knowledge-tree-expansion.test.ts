/**
 * @vitest-environment happy-dom
 *
 * Persistence for the knowledge tree's expansion state.
 *
 * Needs a real `localStorage`: the whole module is the storage boundary, and the
 * behaviour that matters is what it does to *stored* bytes — most of all the
 * one-way migration off the old "collapsed ids" key, which must neither run
 * twice nor run early (running it before the folders are known would persist an
 * empty set and silently wipe an existing user's expansion).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dropLegacyKey,
  expandedKey,
  legacyCollapsedKey,
  loadExpanded,
  migrateLegacyExpanded,
  saveExpanded,
} from './knowledge-tree-expansion';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('loadExpanded', () => {
  it('defaults a fresh browser to the empty set — everything collapsed', () => {
    expect(loadExpanded('team')).toEqual(new Set());
  });

  it('parses the stored ids', () => {
    localStorage.setItem(expandedKey('team'), JSON.stringify([3, 7]));
    expect(loadExpanded('team')).toEqual(new Set([3, 7]));
  });

  it.each([
    ['a non-array', '{"a":1}'],
    ['invalid JSON', '{oops'],
    ['an empty string', ''],
  ])('degrades %s to all-collapsed instead of throwing', (_label, raw) => {
    localStorage.setItem(expandedKey('team'), raw);
    expect(loadExpanded('team')).toEqual(new Set());
  });

  it('drops non-numeric entries', () => {
    localStorage.setItem(expandedKey('team'), JSON.stringify([1, 'two', null, 3]));
    expect(loadExpanded('team')).toEqual(new Set([1, 3]));
  });

  it('reports a pending migration when only the legacy key exists', () => {
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([5]));
    expect(loadExpanded('team')).toBeNull();
  });

  it('ignores the legacy key once the new one exists', () => {
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([5]));
    localStorage.setItem(expandedKey('team'), JSON.stringify([9]));
    expect(loadExpanded('team')).toEqual(new Set([9]));
  });

  it('keeps the two scopes independent', () => {
    localStorage.setItem(expandedKey('team'), JSON.stringify([1]));
    localStorage.setItem(legacyCollapsedKey('private'), JSON.stringify([2]));

    expect(loadExpanded('team')).toEqual(new Set([1]));
    expect(loadExpanded('private')).toBeNull();

    saveExpanded('private', new Set([4]));
    expect(loadExpanded('team')).toEqual(new Set([1]));
    expect(loadExpanded('private')).toEqual(new Set([4]));
  });
});

describe('saveExpanded', () => {
  it('round-trips through storage', () => {
    saveExpanded('private', new Set([2, 8]));
    expect(JSON.parse(localStorage.getItem(expandedKey('private'))!)).toEqual([2, 8]);
    expect(loadExpanded('private')).toEqual(new Set([2, 8]));
  });
});

describe('migrateLegacyExpanded', () => {
  it('expands everything except the folders stored as collapsed', () => {
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([2]));
    expect(migrateLegacyExpanded('team', [1, 2, 3])).toEqual(new Set([1, 3]));
  });

  it('ignores collapsed ids for folders that no longer exist', () => {
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([2, 99]));
    expect(migrateLegacyExpanded('team', [1, 2])).toEqual(new Set([1]));
  });

  it('treats a missing or corrupt legacy key as "nothing was collapsed"', () => {
    expect(migrateLegacyExpanded('team', [1, 2])).toEqual(new Set([1, 2]));
    localStorage.setItem(legacyCollapsedKey('team'), '{oops');
    expect(migrateLegacyExpanded('team', [1, 2])).toEqual(new Set([1, 2]));
  });

  it('runs once: after the migration lands, a reload reads the new key', () => {
    localStorage.setItem(legacyCollapsedKey('team'), JSON.stringify([2]));
    expect(loadExpanded('team')).toBeNull();

    saveExpanded('team', migrateLegacyExpanded('team', [1, 2, 3]));
    dropLegacyKey('team');

    expect(localStorage.getItem(legacyCollapsedKey('team'))).toBeNull();
    expect(loadExpanded('team')).toEqual(new Set([1, 3]));
    // A later collapse survives: the second run must not re-migrate.
    saveExpanded('team', new Set([1]));
    expect(loadExpanded('team')).toEqual(new Set([1]));
  });
});

describe('unavailable storage', () => {
  it('never throws when reads and writes are denied', () => {
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);

    // No stored state is readable, so the tree falls back to its default rather
    // than to a migration it could never finish.
    expect(loadExpanded('team')).toEqual(new Set());
    expect(migrateLegacyExpanded('team', [1, 2])).toEqual(new Set([1, 2]));
    expect(() => saveExpanded('team', new Set([1]))).not.toThrow();
    expect(() => dropLegacyKey('team')).not.toThrow();
  });
});
