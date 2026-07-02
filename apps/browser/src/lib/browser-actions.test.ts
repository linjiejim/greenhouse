/**
 * Descriptor-contract tests — the advertised browser actions must survive the
 * server's sanitizeClientActions() gate unchanged (apps/api/src/tools/
 * client-actions.ts). The limits here mirror that implementation; if a
 * descriptor fails, the server silently DROPS it and the agent loses the tool.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_ACTION_DESCRIPTORS, CONFIRM_ACTIONS } from './browser-actions';

// Server-side caps (keep in sync with sanitizeClientActions).
const MAX_ACTIONS = 32;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 2000;
const NAME_RE = /^[a-z][a-z0-9_]*$/;

describe('BROWSER_ACTION_DESCRIPTORS', () => {
  it('stays within the server action cap', () => {
    expect(BROWSER_ACTION_DESCRIPTORS.length).toBeGreaterThan(0);
    expect(BROWSER_ACTION_DESCRIPTORS.length).toBeLessThanOrEqual(MAX_ACTIONS);
  });

  it('has unique, server-valid names', () => {
    const names = BROWSER_ACTION_DESCRIPTORS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(NAME_RE);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_LEN);
    }
  });

  it('has non-empty descriptions within the server length cap', () => {
    for (const d of BROWSER_ACTION_DESCRIPTORS) {
      expect(d.description.trim().length).toBeGreaterThan(0);
      expect(d.description.length).toBeLessThanOrEqual(MAX_DESC_LEN);
    }
  });

  it('declares parameters as JSON-schema objects with declared required keys', () => {
    for (const d of BROWSER_ACTION_DESCRIPTORS) {
      expect(d.parameters).toBeTypeOf('object');
      expect(Array.isArray(d.parameters)).toBe(false);
      expect(d.parameters.type).toBe('object');
      const properties = d.parameters.properties as Record<string, unknown>;
      expect(properties).toBeTypeOf('object');
      for (const key of (d.parameters.required as string[] | undefined) ?? []) {
        expect(properties, `${d.name} requires undeclared param "${key}"`).toHaveProperty(key);
      }
    }
  });

  it('gates every write action behind confirmation', () => {
    const names = new Set(BROWSER_ACTION_DESCRIPTORS.map((d) => d.name));
    for (const gated of CONFIRM_ACTIONS) {
      expect(names.has(gated), `confirm-gated "${gated}" is not an advertised action`).toBe(true);
    }
    // Interaction writes must never ship ungated.
    expect(CONFIRM_ACTIONS.has('browser_click')).toBe(true);
    expect(CONFIRM_ACTIONS.has('browser_type')).toBe(true);
  });
});
