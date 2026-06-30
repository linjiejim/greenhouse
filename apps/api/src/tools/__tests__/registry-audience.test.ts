/**
 * Tests for the tool-audience boundary: external/anonymous users must only ever
 * receive PUBLIC-audience default-on tools — a `team`/`admin` tool flagged
 * `is_global` (default-on for internal users) must NOT leak into the external
 * allow-set or the external tool-aware system prompt.
 */

import { describe, it, expect } from 'vitest';
import { getPublicToolIds, getGlobalToolIds, getToolMeta, TOOL_DEFINITIONS } from '../registry.js';

describe('getPublicToolIds — external audience', () => {
  it('returns exactly the public-category default-on tools', () => {
    const ids = getPublicToolIds();
    // Every returned tool is both public-category AND default-on.
    for (const id of ids) {
      const meta = getToolMeta(id);
      expect(meta?.category).toBe('public');
      expect(meta?.is_global).toBe(true);
    }
    // It matches the source-of-truth filter on the definitions.
    const expected = TOOL_DEFINITIONS.filter((t) => t.category === 'public' && t.is_global).map((t) => t.id);
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('excludes every team/admin/local tool, even ones marked is_global', () => {
    const publicIds = new Set(getPublicToolIds());
    const internalGlobal = TOOL_DEFINITIONS.filter((t) => t.is_global && t.category !== 'public');
    // Sanity: we actually have internal-but-default-on tools (e.g. team tools).
    expect(internalGlobal.length).toBeGreaterThan(0);
    for (const t of internalGlobal) {
      expect(publicIds.has(t.id)).toBe(false);
    }
  });

  it('is a strict subset of the global tool set', () => {
    const globalIds = new Set(getGlobalToolIds());
    for (const id of getPublicToolIds()) {
      expect(globalIds.has(id)).toBe(true);
    }
    // And strictly smaller, now that team tools are default-on.
    expect(getPublicToolIds().length).toBeLessThan(globalIds.size);
  });
});
