/**
 * Tests for the catalog-driven registry assembly: the static factories, the lazy
 * catalog, and the known-tool name list are all derived from a single source
 * (TOOL_MODULES), not from parallel hand-maintained lists. Guards against a
 * static module missing its `create`, a lazy module missing its
 * `create`/`requires`, and createToolRegistry / LAZY_TOOL_IDS drifting from the
 * catalog.
 */

import { describe, it, expect } from 'vitest';
import { createToolRegistry } from '../../agent.js';
import { STATIC_TOOL_MODULES, LAZY_TOOL_MODULES, getAllToolIds, getToolMeta, TOOL_DEFINITIONS } from '../registry.js';
import { LAZY_TOOL_IDS } from '../../agent-runtime/tool-resolution.js';
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

    // Lazy/per-request tools are NOT in the static registry (injected per-request).
    expect(reg.feature_request).toBeUndefined();
    expect(reg.knowledge_query).toBeUndefined();
  });

  it('getAllToolIds covers static + lazy with no duplicates', () => {
    const ids = getAllToolIds();
    expect(new Set(ids).size).toBe(ids.length); // no dupes

    // representative ids from each construction kind
    for (const id of [
      'analyze_image', // static
      'feature_request', // lazy
      'knowledge_mutation', // lazy
    ]) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });
});

describe('lazy catalog + per-request construction (guard)', () => {
  it('every lazy module declares both create and requires', () => {
    expect(LAZY_TOOL_MODULES.length).toBeGreaterThan(0);
    for (const mod of LAZY_TOOL_MODULES) {
      expect(mod.kind).toBe('lazy');
      expect(typeof mod.create, `lazy tool ${mod.meta.id} missing create`).toBe('function');
      expect(mod.requires, `lazy tool ${mod.meta.id} missing requires`).toBeTruthy();
    }
  });

  it('LAZY_TOOL_IDS is derived from the lazy catalog (no hand-maintained drift)', () => {
    expect([...LAZY_TOOL_IDS].sort()).toEqual(LAZY_TOOL_MODULES.map((m) => m.meta.id).sort());
  });

  it('lazy catalog matches the known per-request tool set (behavior lock)', () => {
    const KNOWN_LAZY = [
      'feature_request',
      'project_manager',
      'email_manager',
      'email_query',
      'email_mutation',
      'personal_knowledge',
      'session_history',
      'project_query',
      'project_mutation',
      'session_query',
      'knowledge_query',
      'knowledge_mutation',
      'spawn_session',
      'call_llm',
    ];
    expect(LAZY_TOOL_MODULES.map((m) => m.meta.id).sort()).toEqual([...KNOWN_LAZY].sort());
  });

  it('static and lazy id sets are disjoint and together cover the catalog', () => {
    const staticIds = STATIC_TOOL_MODULES.map((m) => m.meta.id);
    const lazyIds = LAZY_TOOL_MODULES.map((m) => m.meta.id);
    for (const id of staticIds) expect(lazyIds).not.toContain(id);
    expect([...staticIds, ...lazyIds].sort()).toEqual([...getAllToolIds()].sort());
  });

  it('every meta.id is unique across the catalog', () => {
    const ids = TOOL_DEFINITIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
