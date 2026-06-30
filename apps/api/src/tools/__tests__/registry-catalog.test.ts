/**
 * Tests for the catalog-driven registry assembly: the static tool factories and
 * the known-tool name list are derived from a single source (TOOL_MODULES), not
 * from parallel hand-maintained lists. Guards against a static module missing its
 * `create`, and against createToolRegistry drifting from the catalog.
 */

import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../../agent.js';
import { STATIC_TOOL_MODULES, getAllToolIds, getToolMeta } from '../registry.js';
import type { DatabaseProvider } from '@greenhouse/db';

// Construction only captures db in closures (execute runs later), so a bare stub
// is enough to assemble the registry.
const dbStub = {} as unknown as DatabaseProvider;

describe('catalog-driven registry', () => {
  it('every static module has a create factory and a known meta', () => {
    expect(STATIC_TOOL_MODULES.length).toBeGreaterThan(0);
    for (const mod of STATIC_TOOL_MODULES) {
      expect(mod.kind).toBe('static');
      expect(typeof mod.create).toBe('function');
      expect(getToolMeta(mod.meta.id)).toBeTruthy();
    }
  });

  it('createToolRegistry builds every static tool', () => {
    const reg = createToolRegistry(dbStub);

    // All static module ids are present and callable.
    for (const mod of STATIC_TOOL_MODULES) {
      expect(reg[mod.meta.id], `static tool ${mod.meta.id} missing from registry`).toBeTruthy();
      expect(typeof reg[mod.meta.id].execute).toBe('function');
    }

    // Desktop OS local tools were removed — none are wired into the registry.
    expect(reg.local_shell).toBeUndefined();
    expect(reg.local_file_read).toBeUndefined();

    // Lazy/per-request tools are NOT in the static registry (injected per-request).
    expect(reg.feature_request).toBeUndefined();
    expect(reg.knowledge_query).toBeUndefined();
  });

  it('getAllToolIds covers static + lazy + special + local with no duplicates', () => {
    const ids = getAllToolIds();
    expect(new Set(ids).size).toBe(ids.length); // no dupes

    // representative ids from each construction kind
    for (const id of [
      'analyze_image', // static
      'feature_request', // lazy
      'knowledge_mutation', // lazy
      'local_shell', // special/local
    ]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });
});
